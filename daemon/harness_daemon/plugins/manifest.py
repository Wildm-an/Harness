"""The plugin manifest (``plugin.json``) and the version check.

A bundle is a folder in ``~/.harness/plugins/<name>/`` with a ``plugin.json`` file::

    { "name": "hello",
      "version": "0.1.0",
      "description": "Greets people.",
      "icon": "icon.svg",
      "main": "plugin.py",
      "engines": { "harness": ">=0.1.4" },
      "harness": { "patch": "patch.yml" } }

Only ``name`` and ``version`` are necessary. With no ``harness.patch``, the bundle adds one
plugin row: ``{id: <name>, name: <name>}``. The daemon reads the manifest without running
plugin code.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import __version__
from ..config import ConfigError, read_json

MANIFEST = "plugin.json"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_ICON_BYTES = 256 * 1024
ICON_TYPES = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".webp": "image/webp"}


@dataclass
class Bundle:
    name: str
    version: str
    dir: Path
    description: str = ""
    icon: str | None = None
    main: str = "plugin.py"
    engines: dict[str, str] = field(default_factory=dict)
    patches: list[Path] = field(default_factory=list)  # The patch files of the bundle, in order.

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "version": self.version, "description": self.description,
                "dir": str(self.dir), "icon": self.icon, "engines": self.engines}


def read_manifest(folder: Path) -> Bundle:
    """Read and check ``plugin.json``. Raise ConfigError for a bad manifest."""
    path = folder / MANIFEST
    if not path.is_file():
        raise ConfigError(f"{folder} has no {MANIFEST} file.")
    data = read_json(path, None)
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must be a JSON object.")
    name = data.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ConfigError(f"{path}: 'name' must be 1 to 64 characters: a-z, 0-9, '-' and '_'.")
    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ConfigError(f"{path}: 'version' must be a string, for example \"0.1.0\".")
    main = data.get("main", "plugin.py")
    if not isinstance(main, str) or not _inside(folder, main):
        raise ConfigError(f"{path}: 'main' must be a file in the plugin folder.")
    engines = data.get("engines") or {}
    if not isinstance(engines, dict) or not all(isinstance(v, str) for v in engines.values()):
        raise ConfigError(f"{path}: 'engines' must be an object of version ranges.")
    icon = data.get("icon")
    if icon is not None and (not isinstance(icon, str) or not _inside(folder, icon)
                             or Path(icon).suffix.lower() not in ICON_TYPES):
        raise ConfigError(f"{path}: 'icon' must be an SVG, PNG, JPEG, or WebP file in the plugin folder.")
    harness = data.get("harness") or {}
    if not isinstance(harness, dict):
        raise ConfigError(f"{path}: 'harness' must be an object.")
    raw = harness.get("patch", [])
    raw = [raw] if isinstance(raw, str) else raw
    if not isinstance(raw, list) or not all(isinstance(p, str) and _inside(folder, p) for p in raw):
        raise ConfigError(f"{path}: 'harness.patch' must be a file in the plugin folder, or a list of files.")
    description = data.get("description")
    return Bundle(
        name=name, version=version.strip(), dir=folder,
        description=description if isinstance(description, str) else "",
        icon=icon, main=main, engines=dict(engines), patches=[folder / p for p in raw],
    )


def _inside(folder: Path, rel: str) -> bool:
    if not rel or Path(rel).is_absolute():
        return False
    try:
        (folder / rel).resolve().relative_to(folder.resolve())
    except ValueError:
        return False
    return True


def icon_data(bundle: Bundle) -> str | None:
    """The icon as a data URL, for the Plugins screen. None if there is no icon or it is too large."""
    if not bundle.icon:
        return None
    path = bundle.dir / bundle.icon
    try:
        if path.stat().st_size > MAX_ICON_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    return f"data:{ICON_TYPES[path.suffix.lower()]};base64,{base64.b64encode(data).decode()}"


# -- versions ------------------------------------------------------------------------------------


def _parse_version(text: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", text.split("-")[0].split("+")[0])
    return tuple(int(p) for p in (parts + ["0", "0", "0"])[:3])


def version_matches(spec: str, version: str = __version__) -> bool:
    """True if ``version`` is in the range ``spec``.

    A range is one or more comparisons, separated by spaces: ``>=0.1.4 <0.3``. The operators are
    ``>=``, ``>``, ``<=``, ``<``, ``=``, and ``^`` (same major version; same minor version for 0.x).
    ``*`` or an empty range matches all versions.
    """
    have = _parse_version(version)
    for part in spec.split():
        if part in ("*", "x"):
            continue
        m = re.match(r"^(>=|<=|>|<|=|\^|~)?v?(\d[\w.+-]*)$", part)
        if not m:
            raise ConfigError(f"Not a valid version range: {spec!r}")
        op, want = m.group(1) or "=", _parse_version(m.group(2))
        if op == "^":
            upper = (want[0] + 1, 0, 0) if want[0] > 0 else (0, want[1] + 1, 0)
            ok = want <= have < upper
        elif op == "~":
            ok = want <= have < (want[0], want[1] + 1, 0)
        else:
            ok = {">=": have >= want, ">": have > want, "<=": have <= want, "<": have < want,
                  "=": have == want}[op]
        if not ok:
            return False
    return True


def compatibility_problem(bundle: Bundle) -> str | None:
    """Why the bundle cannot load in this Harness version, or None."""
    spec = bundle.engines.get("harness")
    if not spec:
        return None
    try:
        if version_matches(spec):
            return None
    except ConfigError as e:
        return str(e)
    return f"The plugin needs Harness {spec}. This is Harness {__version__}."
