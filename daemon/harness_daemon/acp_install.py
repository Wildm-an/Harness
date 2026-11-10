"""The downloads of the ACP harnesses: Settings > Operating Harness > "Download" and "Update".

The source is the ACP registry (the list of acp_harnesses.py). For each harness, the registry gives one or
more distributions:

- ``binary``: an archive for each platform, with the program in it, and usually its sha256.
- ``npx``: an npm package at a fixed version. The download installs it with npm.
- ``uvx``: a Python package at a fixed version. The download installs it with ``uv tool install``.

A download goes to ``~/.harness/harnesses/<id>/<version>/``. ``~/.harness/harnesses/<id>/install.json``
has the version, the distribution, and the command. ``acp_harnesses.launch_argv`` uses a download first.

An update is available when the registry has a newer version than the download. The daemon reads the
registry at most each ``REGISTRY_TTL`` seconds. "Check again" reads it at once.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import platform
import re
import shutil
import stat
import sys
import tarfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Awaitable, Callable
from urllib.parse import unquote, urlparse

from .config import harness_home, read_json, write_json

if TYPE_CHECKING:
    from .acp_harnesses import HarnessSpec

log = logging.getLogger(__name__)

REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
REGISTRY_TTL = 6 * 3600
MAX_ARCHIVE = 2 * 1024 ** 3  # The largest archive: 2 GB.
INSTALL_TIMEOUT = 15 * 60  # npm and uv: the longest install.
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

# progress(stage, received bytes, total bytes). total 0: the size is not known.
Progress = Callable[[str, int, int], Awaitable[None]]


class InstallError(Exception):
    pass


# -- the registry -------------------------------------------------------------------------------------------

_registry: dict[str, dict[str, Any]] | None = None
_registry_time = 0.0


def _registry_url() -> str:
    return os.environ.get("HARNESS_ACP_REGISTRY") or REGISTRY_URL


def _cache_path() -> Path:
    return harness_home() / "harnesses" / "registry.json"


def _check_url(url: str) -> None:
    """Only HTTPS, or HTTP on this computer (the tests)."""
    parsed = urlparse(url)
    if parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in LOOPBACK):
        return
    raise InstallError(f"Harness downloads only from HTTPS addresses: {url}")


def _agents(data: Any) -> dict[str, dict[str, Any]]:
    agents = data.get("agents") if isinstance(data, dict) else None
    return {a["id"]: a for a in agents or [] if isinstance(a, dict) and isinstance(a.get("id"), str)}


def registry() -> dict[str, dict[str, Any]]:
    """The agents of the registry, by id: the last copy that the daemon read. Empty before the first read."""
    global _registry
    if _registry is None:
        _registry = _agents(read_json(_cache_path(), {}))
    return _registry


def registry_stale() -> bool:
    return time.time() - _registry_time > REGISTRY_TTL


async def refresh_registry(force: bool = False) -> bool:
    """Read the registry again when the copy is old (or ``force``). True: the copy changed.
    A failure keeps the old copy."""
    global _registry, _registry_time
    if not force and not registry_stale():
        return False
    from .nethttp import async_client

    url = _registry_url()
    try:
        _check_url(url)
        async with async_client(timeout=20, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
    except Exception as e:  # noqa: BLE001 - no network: the old copy stays.
        log.info("Could not read the ACP registry: %s", e)
        _registry_time = time.time() - REGISTRY_TTL + 300  # Try again after 5 minutes.
        return False
    _registry_time = time.time()
    agents = _agents(data)
    if not agents:
        return False
    changed = agents != registry()
    _registry = agents
    try:
        write_json(_cache_path(), data)
    except OSError:
        pass
    return changed


# -- the platform and the distribution ----------------------------------------------------------------------

def platform_key() -> str:
    """The platform name of the registry, for example "windows-x86_64" or "linux-aarch64-musl"."""
    system = {"win32": "windows", "darwin": "darwin"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    arch = "aarch64" if machine in ("arm64", "aarch64", "armv8l") else "x86_64"
    key = f"{system}-{arch}"
    if system == "linux" and not platform.libc_ver()[0] and list(Path("/lib").glob("ld-musl-*")):
        key += "-musl"
    return key


def _package_version(package: str) -> str:
    """The version of "name@1.2.3", "@scope/name@1.2.3", or "name==1.2.3"."""
    if "==" in package:
        return package.split("==", 1)[1]
    at = package.rfind("@")
    return package[at + 1:] if at > 0 else ""


def _package_name(package: str) -> str:
    if "==" in package:
        return package.split("==", 1)[0]
    at = package.rfind("@")
    return package[:at] if at > 0 else package


def plan(spec: "HarnessSpec") -> tuple[str, dict[str, Any], str] | None:
    """How Harness can download the harness: (kind, distribution, version). None: it cannot.
    The registry comes first. Without a registry entry, the npx or uvx package of the catalog."""
    if spec.custom:
        return None
    agent = registry().get(spec.id)
    dist = agent.get("distribution") if isinstance(agent, dict) and isinstance(agent.get("distribution"), dict) else {}
    version = str(agent.get("version") or "") if isinstance(agent, dict) else ""
    binary = dist.get("binary") if isinstance(dist.get("binary"), dict) else {}
    target = binary.get(platform_key())
    if not isinstance(target, dict) and platform_key().endswith("-musl"):
        target = binary.get(platform_key().removesuffix("-musl"))
    if isinstance(target, dict) and isinstance(target.get("archive"), str) and isinstance(target.get("cmd"), str):
        return "binary", target, version or "latest"
    npx = dist.get("npx") if isinstance(dist.get("npx"), dict) else None
    if npx is None and spec.npx is not None:
        npx = {"package": spec.npx[0], "args": list(spec.npx[1])}
    if npx and isinstance(npx.get("package"), str) and shutil.which("npm"):
        return "npx", npx, version or _package_version(npx["package"]) or "latest"
    uvx = dist.get("uvx") if isinstance(dist.get("uvx"), dict) else None
    if uvx is None and spec.uvx is not None:
        uvx = {"package": spec.uvx[0], "args": list(spec.uvx[1])}
    if uvx and isinstance(uvx.get("package"), str) and shutil.which("uv"):
        return "uvx", uvx, version or _package_version(uvx["package"]) or "latest"
    return None


def latest_version(spec: "HarnessSpec") -> str | None:
    agent = registry().get(spec.id)
    version = agent.get("version") if isinstance(agent, dict) else None
    return version if isinstance(version, str) and version else None


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", version))


def is_newer(latest: str | None, current: str | None) -> bool:
    if not latest or not current or latest == current:
        return False
    a, b = _version_key(latest), _version_key(current)
    return a > b if a and b else True


# -- the downloads on this computer -------------------------------------------------------------------------

def _root(harness_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", harness_id):
        raise InstallError(f"Not a harness id: {harness_id}")
    return harness_home() / "harnesses" / harness_id


def installed(harness_id: str) -> dict[str, Any] | None:
    """The download of the harness: {"version", "kind", "argv", "env", "dir"}. None: no download, or its
    program is gone."""
    try:
        root = _root(harness_id)
    except InstallError:
        return None
    data = read_json(root / "install.json", {})
    if not isinstance(data, dict) or not isinstance(data.get("argv"), list) or not data["argv"]:
        return None
    if not Path(str(data["argv"][0])).exists():
        return None
    return data


# The downloads that run now: harness id -> {"stage", "received", "total"}.
_running: dict[str, dict[str, Any]] = {}


def busy(harness_id: str) -> dict[str, Any] | None:
    return _running.get(harness_id)


def _rmtree(path: Path) -> None:
    def retry(func: Any, p: str, _exc: Any) -> None:
        os.chmod(p, stat.S_IWRITE)  # A read-only file on Windows.
        func(p)

    if path.exists():
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=retry)
        else:
            shutil.rmtree(path, onerror=retry)


def remove(harness_id: str) -> None:
    """Delete the download of the harness."""
    root = _root(harness_id)
    if harness_id in _running:
        raise InstallError("The download runs now. Wait for its end.")
    if not root.exists():
        raise InstallError("The harness has no download.")
    try:
        _rmtree(root)
    except OSError as e:
        raise InstallError(f"Could not delete the download: {e}. Close the sessions that use the harness, "
                           "then try again.") from None


async def install(spec: "HarnessSpec", progress: Progress) -> dict[str, Any]:
    """Download the newest version of the harness. Return the new install.json."""
    if spec.id in _running:
        raise InstallError(f"{spec.name} downloads now.")
    _running[spec.id] = {"stage": "Starting", "received": 0, "total": 0}

    async def report(stage: str, received: int = 0, total: int = 0) -> None:
        _running[spec.id] = {"stage": stage, "received": received, "total": total}
        await progress(stage, received, total)

    try:
        await report("Checking the registry")
        await refresh_registry(force=True)
        chosen = plan(spec)
        if chosen is None:
            raise InstallError(f"Harness cannot download {spec.name} for this computer ({platform_key()}). "
                               + (f"Install it from {spec.website}." if spec.website else "Install it first."))
        kind, dist, version = chosen
        root = _root(spec.id)
        safe_version = re.sub(r"[^A-Za-z0-9._+-]", "_", version)[:60] or "latest"
        target = root / safe_version
        old = installed(spec.id)
        if target.exists():
            try:
                _rmtree(target)
            except OSError as e:
                raise InstallError(f"Could not replace the old files: {e}. Close the sessions that use "
                                   f"{spec.name}, then try again.") from None
        target.mkdir(parents=True)
        try:
            if kind == "binary":
                argv = await _install_binary(dist, target, report)
            elif kind == "npx":
                argv = await _install_npm(dist, target, report)
            else:
                argv = await _install_uv(dist, target, report)
        except BaseException:
            try:
                _rmtree(target)
            except OSError:
                pass
            raise
        env = {str(k): str(v) for k, v in (dist.get("env") or {}).items()} if isinstance(dist.get("env"), dict) else {}
        data = {"version": version, "kind": kind, "argv": argv, "env": env, "dir": str(target),
                "time": int(time.time())}
        write_json(root / "install.json", data)
        # The old version goes. A running session can lock its files on Windows: then they stay.
        if old and old.get("dir") and Path(old["dir"]) != target:
            try:
                _rmtree(Path(old["dir"]))
            except OSError:
                log.info("The old download of %s stays: its files are in use.", spec.id)
        return data
    finally:
        _running.pop(spec.id, None)


# -- binary -------------------------------------------------------------------------------------------------

def _archive_name(url: str) -> str:
    return unquote(PurePosixPath(urlparse(url).path).name) or "download"


async def _fetch(url: str, path: Path, sha256: str | None, report: Callable[..., Awaitable[None]]) -> None:
    from .nethttp import async_client

    _check_url(url)
    digest = hashlib.sha256()
    received = 0
    last = 0.0
    async with async_client(timeout=60, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise InstallError(f"The download failed: HTTP {response.status_code} for {url}")
            total = int(response.headers.get("content-length") or 0)
            with open(path, "wb") as f:
                async for chunk in response.aiter_bytes(256 * 1024):
                    received += len(chunk)
                    if received > MAX_ARCHIVE:
                        raise InstallError("The download is larger than 2 GB.")
                    f.write(chunk)
                    digest.update(chunk)
                    if time.monotonic() - last > 0.25:
                        last = time.monotonic()
                        await report("Downloading", received, total)
    await report("Downloading", received, received)
    if sha256 and digest.hexdigest().lower() != sha256.lower():
        raise InstallError("The download does not have the sha256 of the registry. Harness deleted it.")


def _inside(root: Path, name: str) -> Path:
    """The path of an archive member. Stop for an absolute path or "..": the member cannot go out of root."""
    parts = PurePosixPath(name.replace("\\", "/")).parts
    if not parts or name.startswith(("/", "\\")) or ".." in parts or re.match(r"^[A-Za-z]:", name):
        raise InstallError(f"The archive has a file out of its folder: {name}")
    return root.joinpath(*parts)


def _extract(archive: Path, target: Path) -> None:
    name = archive.name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                dest = _inside(target, info.filename)
                if info.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                mode = info.external_attr >> 16
                if mode & 0o111 and os.name != "nt":
                    dest.chmod(dest.stat().st_mode | 0o755)
        return
    if re.search(r"\.(tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar)$", name):
        with tarfile.open(archive) as t:
            for member in t.getmembers():
                dest = _inside(target, member.name)
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    src = t.extractfile(member)
                    assert src is not None
                    with src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                    if member.mode & 0o111 and os.name != "nt":
                        dest.chmod(0o755)
                # Links and devices: not needed for a program, and not safe. Skip them.
        return
    # A program with no archive (for example an .exe).
    shutil.copyfile(archive, target / archive.name)
    if os.name != "nt":
        (target / archive.name).chmod(0o755)


async def _install_binary(dist: dict[str, Any], target: Path, report: Callable[..., Awaitable[None]]) -> list[str]:
    url = dist["archive"]
    download = target.parent / f".{target.name}.download"
    download.mkdir(parents=True, exist_ok=True)
    try:
        archive = download / _archive_name(url)
        sha = dist.get("sha256") if isinstance(dist.get("sha256"), str) else None
        await _fetch(url, archive, sha, report)
        await report("Unpacking")
        try:
            await asyncio.to_thread(_extract, archive, target)
        except (zipfile.BadZipFile, tarfile.TarError) as e:
            raise InstallError(f"Could not unpack the download: {e}") from None
    finally:
        await asyncio.to_thread(shutil.rmtree, download, True)
    program = _inside(target, dist["cmd"])
    if not program.is_file():
        raise InstallError(f"The download has no {dist['cmd']}.")
    if os.name != "nt":
        program.chmod(program.stat().st_mode | 0o755)
    return [str(program), *[str(a) for a in dist.get("args") or []]]


# -- npm and uv ---------------------------------------------------------------------------------------------

async def _run(argv: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(cwd), stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, env={**os.environ, **(env or {})})
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), INSTALL_TIMEOUT)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    if proc.returncode != 0:
        tail = "\n".join(out.decode("utf-8", "replace").strip().splitlines()[-6:])
        raise InstallError(f"{Path(argv[0]).stem} failed (exit {proc.returncode}): {tail}")


def _npm_bin(target: Path, package: str) -> str:
    """The program of the package in node_modules/.bin (a .cmd file on Windows)."""
    name = _package_name(package)
    meta = read_json(target / "node_modules" / Path(*name.split("/")) / "package.json", {})
    bins = meta.get("bin") if isinstance(meta, dict) else None
    short = name.rsplit("/", 1)[-1]
    if isinstance(bins, str):
        program = short
    elif isinstance(bins, dict) and bins:
        program = short if short in bins else next(iter(bins))
    else:
        raise InstallError(f"The npm package {name} has no program.")
    path = target / "node_modules" / ".bin" / (f"{program}.cmd" if os.name == "nt" else program)
    if not path.exists():
        raise InstallError(f"npm did not make the program {program}.")
    return str(path)


async def _install_npm(dist: dict[str, Any], target: Path, report: Callable[..., Awaitable[None]]) -> list[str]:
    npm = shutil.which("npm")
    if npm is None:
        raise InstallError("Install Node.js (it has npm) on the daemon computer.")
    package = dist["package"]
    await report("Installing with npm")
    (target / "package.json").write_text('{"private": true}\n', encoding="utf-8")
    await _run([npm, "install", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", package], target)
    return [_npm_bin(target, package), *[str(a) for a in dist.get("args") or []]]


async def _install_uv(dist: dict[str, Any], target: Path, report: Callable[..., Awaitable[None]]) -> list[str]:
    uv = shutil.which("uv")
    if uv is None:
        raise InstallError("Install uv on the daemon computer.")
    package = dist["package"]
    await report("Installing with uv")
    bin_dir = target / "bin"
    await _run([uv, "tool", "install", "--force", package], target,
               {"UV_TOOL_DIR": str(target / "tools"), "UV_TOOL_BIN_DIR": str(bin_dir)})
    programs = sorted(p for p in bin_dir.iterdir() if p.is_file()) if bin_dir.is_dir() else []
    name = _package_name(package).lower()
    program = next((p for p in programs if p.stem.lower() == name), programs[0] if programs else None)
    if program is None:
        raise InstallError(f"uv did not make a program for {name}.")
    return [str(program), *[str(a) for a in dist.get("args") or []]]


def summary(spec: "HarnessSpec") -> dict[str, Any]:
    """The download fields of a harness for the client (acp_harnesses.public)."""
    data = installed(spec.id)
    latest = latest_version(spec)
    version = str(data.get("version")) if data else None
    return {
        "download": {"version": version, "kind": data.get("kind")} if data else None,
        "latest": latest,
        "update": bool(data) and is_newer(latest, version),
        "can_download": plan(spec) is not None,
        "busy": busy(spec.id),
    }
