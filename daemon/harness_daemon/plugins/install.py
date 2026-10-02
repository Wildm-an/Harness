"""Installed bundles: the plugin folder, the bundle state, install, and remove.

- The bundles are the folders in ``~/.harness/plugins/``. Each folder has a ``plugin.json``.
- ``~/.harness/plugins.json`` keeps the bundle order, the on/off state, and the install source::

      { "bundles": { "hello": { "enabled": true, "source": "https://github.com/me/hello.git" } } }

  A folder that is not in the file is on. It comes after the listed bundles, by name. Thus you
  can also install a bundle by hand: copy its folder into ``~/.harness/plugins/``.
- Install copies a local folder, or clones a git repository. It does not run plugin code.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import ConfigError, harness_home, read_json, write_json
from .manifest import Bundle, compatibility_problem, read_manifest
from .patch import Layer, read_patch_file, user_patch_path, write_patch_file

log = logging.getLogger(__name__)

STATE_FILE = "plugins.json"
IGNORED = shutil.ignore_patterns(".git", "__pycache__", "node_modules", ".venv", "*.pyc")
GIT_TIMEOUT = 120
GIT_RE = re.compile(r"^(https?://|ssh://|git@|github:)")


class InstallError(Exception):
    pass


@dataclass
class Installed:
    bundle: Bundle | None  # None: the folder has a bad manifest.
    dir: Path
    enabled: bool
    source: str | None
    problem: str | None = None  # Why the bundle cannot load: a bad manifest, a version, or a duplicate name.

    @property
    def name(self) -> str:
        return self.bundle.name if self.bundle else self.dir.name


def plugins_dir() -> Path:
    return harness_home() / "plugins"


def state_path() -> Path:
    return harness_home() / STATE_FILE


def read_state() -> dict[str, dict[str, Any]]:
    data = read_json(state_path(), {})
    bundles = data.get("bundles") if isinstance(data, dict) else None
    return {k: v for k, v in bundles.items() if isinstance(v, dict)} if isinstance(bundles, dict) else {}


def write_state(bundles: dict[str, dict[str, Any]]) -> None:
    write_json(state_path(), {"bundles": bundles})


def installed_bundles() -> list[Installed]:
    """All bundle folders, in the bundle order."""
    root = plugins_dir()
    state = read_state()
    found: list[Installed] = []
    if root.is_dir():
        for folder in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            try:
                bundle = read_manifest(folder)
            except ConfigError as e:
                found.append(Installed(None, folder, False, None, str(e)))
                continue
            entry = state.get(bundle.name, {})
            found.append(Installed(bundle, folder, entry.get("enabled", True) is not False, entry.get("source"),
                                   compatibility_problem(bundle)))
    order = list(state)
    found.sort(key=lambda i: (order.index(i.name) if i.name in order else len(order), i.name))
    seen: set[str] = set()
    for item in found:
        if item.bundle and item.name in seen:
            item.problem = f"Another folder has the same plugin name {item.name!r}."
        seen.add(item.name)
    return found


def bundle_layers(items: list[Installed]) -> tuple[list[Layer], list[str]]:
    """The patch layers of the bundles that are on and can load. A bundle with no patch adds one row."""
    layers: list[Layer] = []
    warnings: list[str] = []
    for item in items:
        if not item.enabled or item.problem or item.bundle is None:
            continue
        b = item.bundle
        if not b.patches:
            layers.append(Layer(f"bundle:{b.name}", b.dir / "plugin.json", [{"insert": [{"id": b.name, "name": b.name}]}]))
            continue
        for path in b.patches:
            try:
                layers.append(Layer(f"bundle:{b.name}", path, read_patch_file(path)))
            except ValueError as e:
                warnings.append(str(e))
    return layers, warnings


# -- install and remove ------------------------------------------------------------------------------------


def is_git_source(source: str) -> bool:
    return bool(GIT_RE.match(source)) or source.endswith(".git")


def _git_url(source: str) -> tuple[str, str | None]:
    """The clone URL and the ref (after "#"). "github:user/repo" is a GitHub repository."""
    url, _, ref = source.partition("#")
    if url.startswith("github:"):
        url = f"https://github.com/{url[len('github:'):]}.git"
    return url, ref or None


def _clone(source: str, dest: Path) -> None:
    url, ref = _git_url(source)
    command = ["git", "clone", "--depth", "1", *(["--branch", ref] if ref else []), "--", url, str(dest)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=GIT_TIMEOUT,
                                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except FileNotFoundError:
        raise InstallError("Git is not installed on the daemon computer. Install git, or install from a folder.") from None
    except subprocess.TimeoutExpired:
        raise InstallError(f"The git clone did not finish in {GIT_TIMEOUT} seconds.") from None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise InstallError(f"The git clone failed: {detail[-1] if detail else 'no output'}")
    remove_tree(dest / ".git")


def install(source: str, replace: bool = False) -> Installed:
    """Install a bundle from a local folder or a git URL. Return the installed bundle.

    ``replace``: an installed bundle with the same name is replaced (an update).
    """
    source = source.strip()
    if not source:
        raise InstallError("Give a folder or a git URL.")
    root = plugins_dir()
    root.mkdir(parents=True, exist_ok=True)
    staging = root / f".staging-{secrets.token_hex(6)}"
    try:
        if is_git_source(source):
            _clone(source, staging)
        else:
            folder = Path(source).expanduser()
            if not folder.is_dir():
                raise InstallError(f"The folder does not exist: {source}")
            folder = folder.resolve()
            try:
                folder.relative_to(root.resolve())
                raise InstallError("The folder is already in the plugins folder.")
            except ValueError:
                pass
            shutil.copytree(folder, staging, ignore=IGNORED)
            source = str(folder)
        try:
            bundle = read_manifest(staging)
        except ConfigError as e:
            raise InstallError(str(e).replace(str(staging), "the plugin folder")) from None
        if not (staging / bundle.main).is_file():
            raise InstallError(f"The main file {bundle.main} of the plugin does not exist.")
        problem = compatibility_problem(bundle)
        if problem:
            raise InstallError(problem)
        existing = next((i for i in installed_bundles() if i.name == bundle.name), None)
        if existing is not None and not replace:
            raise InstallError(f"The plugin {bundle.name!r} is already installed. Remove it first, or update it.")
        dest = existing.dir if existing is not None else root / bundle.name
        if dest.exists():
            if existing is None:
                raise InstallError(f"The folder {dest} already exists.")
            remove_tree(dest)
        staging.replace(dest)
    finally:
        if staging.exists():
            remove_tree(staging)
    state = read_state()
    entry = state.setdefault(bundle.name, {"enabled": True})
    entry["source"] = source
    write_state(state)
    return next(i for i in installed_bundles() if i.name == bundle.name)


def remove(name: str) -> None:
    """Delete an installed bundle, its state, and the user-layer overrides of its rows."""
    item = next((i for i in installed_bundles() if i.name == name), None)
    if item is None:
        raise InstallError(f"The plugin {name!r} is not installed.")
    row_ids = set()
    if item.bundle is not None:
        layers, _ = bundle_layers([Installed(item.bundle, item.dir, True, None)])
        row_ids = {e.get("id") for layer in layers for p in layer.patches for e in p.get("insert") or []
                   if isinstance(e, dict)}
    remove_tree(item.dir)
    state = read_state()
    if state.pop(name, None) is not None:
        write_state(state)
    try:
        patches = read_patch_file(user_patch_path())
    except ValueError:
        return
    kept = [p for p in patches if "insert" in p or p.get("id") not in row_ids]
    if len(kept) != len(patches):
        write_patch_file(user_patch_path(), kept)


def set_bundle_enabled(name: str, enabled: bool) -> None:
    if not any(i.name == name for i in installed_bundles()):
        raise InstallError(f"The plugin {name!r} is not installed.")
    state = read_state()
    state.setdefault(name, {})["enabled"] = enabled
    write_state(state)


def remove_tree(path: Path) -> None:
    """Delete a folder. On Windows, git makes read-only files: make them writable first."""
    def on_error(func, target, _exc):  # noqa: ANN001
        os.chmod(target, stat.S_IWRITE)
        func(target)
    if path.exists():
        shutil.rmtree(path, onerror=on_error)


# The data of the DeepSeek Harness plugins. Version 0.1.32 removed them.
OLD_DEEPSEEK_DATA = ("dsh", "plugin-host-path")


def remove_old_deepseek_data() -> None:
    """Delete the DeepSeek plugin profile (~/.harness/dsh) and the plugin host hint, if they exist."""
    for name in OLD_DEEPSEEK_DATA:
        path = harness_home() / name
        try:
            if path.is_dir():
                remove_tree(path)
            elif path.exists():
                path.unlink()
        except OSError as e:
            log.warning("Could not delete the old DeepSeek plugin data %s: %s", path, e)
