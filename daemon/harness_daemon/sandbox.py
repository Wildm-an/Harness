"""The sandbox of the bash tool: the settings, the policy, the status, and the backends. See docs/SANDBOX.md.

The settings are the "sandbox" object of ~/.harness/settings.json, with the key names of Claude Code. A project
settings file cannot change them: a repository must not turn the sandbox off or add a write folder.

The backends put a prefix before the shell arguments (wrap):

- macOS: Seatbelt (``sandbox-exec -p <profile>``).
- Linux: bubblewrap (``bwrap``).
- Windows: no backend yet. sandbox_status gives "unavailable", and commands run with no sandbox.

The network is off in the sandbox. When sandbox.network.allowedDomains has a domain, the bash tool starts a proxy
in the daemon for each command (sandbox_proxy.py). HTTP_PROXY and HTTPS_PROXY point to it. The proxy checks each
host against allowedDomains and deniedDomains. On macOS, the profile allows only the connection to the proxy port.
On Linux, the command has its own network namespace: socat in the sandbox connects a local port to the Unix socket
of the proxy. With no socat, the network stays off on Linux.

The sandbox applies to the foreground commands of the bash tool only. Background tasks, hooks, MCP servers,
plugins, dev servers, and the terminal pane run with no sandbox.
"""

from __future__ import annotations

import fnmatch
import functools
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .config import ConfigError, harness_home, read_json, write_json

# The defaults are the Claude Code defaults. The sandbox is off until the user sets "enabled" to true.
SANDBOX_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "failIfUnavailable": False,
    "autoAllowBashIfSandboxed": True,
    "allowUnsandboxedCommands": True,
    "excludedCommands": [],
    "network": {"allowedDomains": [], "deniedDomains": [], "allowLocalBinding": False},
    "filesystem": {"allowWrite": [], "denyWrite": [], "denyRead": [], "allowRead": []},
}

SEATBELT_PROGRAM = "/usr/bin/sandbox-exec"

# The secret files of Harness. A sandboxed command cannot read them.
SECRET_FILES = ("daemon-token", "mcp-auth.json", "providers.json")
# Project paths that hold settings, hooks, or repository state (the protected paths of auto_mode.py). A sandboxed
# command cannot write them. Git must write in .git, so only the hooks and the config of .git are on the list.
PROTECTED_PROJECT_PATHS = (".git/hooks", ".git/config", ".harness", ".claude", ".vscode", ".idea", ".husky",
                           ".github", ".devcontainer", ".circleci", ".gitlab", ".mcp.json", ".npmrc", ".pypirc",
                           ".gitmodules", ".gitconfig", ".bashrc", ".zshrc", ".profile", ".bash_profile",
                           "profile.ps1", ".gitlab-ci.yml")
# The shell profiles and the git settings in the home folder. A sandboxed command cannot write them.
HOME_PROFILES = (".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile",
                 ".zlogin", ".gitconfig", ".config/git", ".ssh")
# Package caches in the home folder. A sandboxed command can write them, so that npm, pip, and cargo work.
CACHE_DIRS = (".npm", ".cache", "Library/Caches", ".cargo/registry", ".cargo/git", ".pnpm-store",
              ".local/share/pnpm", ".yarn", "go/pkg/mod", ".gradle/caches", ".m2/repository")

OFF_REASON = "The sandbox is off. Set sandbox.enabled to true in ~/.harness/settings.json to turn it on."
READY_REASON = "Commands of the bash tool run in the sandbox: no network, and writes only in the allowed folders."
READY_PROXY_REASON = ("Commands of the bash tool run in the sandbox: network only to the allowed domains, and writes "
                      "only in the allowed folders.")
NO_SOCAT_REASON = ("Commands of the bash tool run in the sandbox: no network, and writes only in the allowed folders. "
                   "Install socat to use sandbox.network.allowedDomains.")
WINDOWS_REASON = "Harness has no sandbox for Windows yet. Commands run with no sandbox."
OTHER_REASON = "Harness has no sandbox for this system. Commands run with no sandbox."
NO_SEATBELT = f"{SEATBELT_PROGRAM} is not on this computer. Commands run with no sandbox."
NO_BWRAP = "bubblewrap (bwrap) is not installed. Install the bubblewrap package. Commands run with no sandbox."
BWRAP_FAILED = "bubblewrap (bwrap) does not start a sandbox on this computer: {error} Commands run with no sandbox."


class SandboxError(Exception):
    """The sandbox cannot run a command."""


@dataclass(frozen=True)
class SandboxPolicy:
    """What a sandboxed command can do. The paths are absolute and resolved.

    A deny path wins over a write root. An ``allow_read`` path wins over a deny-read path.
    """

    write_roots: tuple[str, ...]
    deny_write: tuple[str, ...] = ()
    deny_read: tuple[str, ...] = ()
    allow_read: tuple[str, ...] = ()
    network: str = "off"  # "off", "proxy" (only through the proxy of sandbox_proxy.py), or "on".
    allow_local_binding: bool = False  # macOS: a server on localhost can run.
    temp_dir: str | None = None  # The temp folder of the session. TMPDIR, TMP, and TEMP point to it.
    # network "proxy": the port of the proxy in the sandbox. On Linux, socat listens on this port in the sandbox
    # and connects to the Unix socket ``proxy_socket`` of the proxy.
    proxy_port: int | None = None
    proxy_socket: str | None = None


# -- the settings --------------------------------------------------------------------------------------------


def _strings(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str) and v.strip()] if isinstance(value, list) else []


def normalize_config(raw: Any) -> dict[str, Any]:
    """The "sandbox" object with all keys. A value of the wrong type gets the default."""
    raw = raw if isinstance(raw, dict) else {}
    config: dict[str, Any] = {}
    for key in ("enabled", "failIfUnavailable", "autoAllowBashIfSandboxed", "allowUnsandboxedCommands"):
        value = raw.get(key)
        config[key] = value if isinstance(value, bool) else SANDBOX_DEFAULTS[key]
    config["excludedCommands"] = _strings(raw.get("excludedCommands"))
    network = raw.get("network") if isinstance(raw.get("network"), dict) else {}
    config["network"] = {
        "allowedDomains": _strings(network.get("allowedDomains")),
        "deniedDomains": _strings(network.get("deniedDomains")),
        "allowLocalBinding": network.get("allowLocalBinding") is True,
    }
    files = raw.get("filesystem") if isinstance(raw.get("filesystem"), dict) else {}
    config["filesystem"] = {key: _strings(files.get(key)) for key in ("allowWrite", "denyWrite", "denyRead",
                                                                       "allowRead")}
    return config


def sandbox_config() -> dict[str, Any]:
    """The "sandbox" object of ~/.harness/settings.json, with the defaults. Never from a project file."""
    try:
        settings = read_json(harness_home() / "settings.json", {})
    except ConfigError:
        settings = {}
    return normalize_config(settings.get("sandbox") if isinstance(settings, dict) else None)


def set_enabled(enabled: bool) -> None:
    """Write sandbox.enabled in ~/.harness/settings.json (Settings > Local sandbox). The other keys stay.

    Only the user file: a project file cannot change the sandbox. Raises ConfigError if the file is not valid JSON.
    """
    path = harness_home() / "settings.json"
    data = read_json(path, {})
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must hold a JSON object.")
    box = data.get("sandbox") if isinstance(data.get("sandbox"), dict) else {}
    data["sandbox"] = {**box, "enabled": bool(enabled)}
    write_json(path, data)


# -- the status ----------------------------------------------------------------------------------------------


def backend_for(platform: str | None = None) -> str:
    """The backend of the system: "seatbelt", "bubblewrap", "windows", or "none"."""
    platform = platform or sys.platform
    if platform == "darwin":
        return "seatbelt"
    if platform.startswith("linux"):
        return "bubblewrap"
    if platform in ("win32", "cygwin"):
        return "windows"
    return "none"


def _find_bwrap() -> str | None:
    return shutil.which("bwrap")


@functools.lru_cache(maxsize=4)
def _probe_bwrap(path: str) -> str | None:
    """None if bwrap starts a sandbox, else the error. Ubuntu 24.04 can block the user namespaces of bwrap."""
    try:
        done = subprocess.run([path, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--",
                               "/bin/sh", "-c", "exit 0"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        return str(e)
    if done.returncode == 0:
        return None
    text = done.stderr.decode("utf-8", errors="replace").strip().splitlines()
    return text[0] if text else f"exit code {done.returncode}."


def _backend_problem(backend: str) -> str | None:
    """None if the backend can run, else the reason."""
    if backend == "seatbelt":
        return None if os.path.isfile(SEATBELT_PROGRAM) else NO_SEATBELT
    if backend == "bubblewrap":
        path = _find_bwrap()
        if path is None:
            return NO_BWRAP
        error = _probe_bwrap(path)
        return None if error is None else BWRAP_FAILED.format(error=error)
    return WINDOWS_REASON if backend == "windows" else OTHER_REASON


def _find_socat() -> str | None:
    return shutil.which("socat")


def network_mode(config: dict[str, Any], platform: str | None = None) -> str:
    """The network of a sandboxed command: "proxy" (only the allowed domains) or "off".

    "proxy" needs a domain in network.allowedDomains, and a backend that can limit the network to the proxy:
    Seatbelt, or bubblewrap with socat.
    """
    if not (config.get("network") or {}).get("allowedDomains"):
        return "off"
    backend = backend_for(platform)
    if backend == "seatbelt" or (backend == "bubblewrap" and _find_socat() is not None):
        return "proxy"
    return "off"


def sandbox_status(config: dict[str, Any] | None = None, platform: str | None = None) -> dict[str, Any]:
    """{"state": "ready" | "unavailable" | "off", "backend": ..., "reason": ..., "available": bool} for the daemon
    computer.

    "available": the system has a backend. In the "off" state with no backend, the reason tells why, so that the
    Settings row can show it. The "off" state does not start bwrap: it only looks for the program.
    """
    config = sandbox_config() if config is None else config
    backend = backend_for(platform)
    if not config.get("enabled"):
        if backend == "bubblewrap":
            problem = None if _find_bwrap() is not None else NO_BWRAP
        else:
            problem = _backend_problem(backend)
        return {"state": "off", "backend": backend, "reason": problem or OFF_REASON, "available": problem is None}
    problem = _backend_problem(backend)
    if problem is not None:
        return {"state": "unavailable", "backend": backend, "reason": problem, "available": False}
    reason = READY_REASON
    if (config.get("network") or {}).get("allowedDomains"):
        reason = READY_PROXY_REASON if network_mode(config, platform) == "proxy" else NO_SOCAT_REASON
    return {"state": "ready", "backend": backend, "reason": reason, "available": True}


# -- the policy ----------------------------------------------------------------------------------------------


def _unique(paths: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(paths))


def _real(path: Path) -> str:
    return os.path.realpath(path)


def _user_path(value: str, cwd: Path, home: Path) -> Path:
    """A path of the settings: "~/" is the home folder, and a relative path is in the project folder."""
    if value == "~" or value.startswith(("~/", "~\\")):
        return home / value[2:]
    path = Path(value)
    return path if path.is_absolute() else cwd / path


def _inside(path: Path, folder: Path) -> bool:
    try:
        Path(_real(path)).relative_to(_real(folder))
    except ValueError:
        return False
    return True


def git_common_dir(cwd: Path) -> Path | None:
    """The .git folder of the main project, for a worktree. Git writes there also in a worktree session."""
    marker = cwd / ".git"
    if not marker.is_file():
        return None
    try:
        text = marker.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not text.startswith("gitdir:"):
        return None
    gitdir = Path(text[len("gitdir:"):].strip())
    gitdir = gitdir if gitdir.is_absolute() else cwd / gitdir
    try:
        common = (gitdir / "commondir").read_text(encoding="utf-8").strip()
    except OSError:
        return gitdir
    common_path = Path(common)
    return common_path if common_path.is_absolute() else gitdir / common_path


def policy_for(cwd: Path, session_tmp: Path, config: dict[str, Any], home: Path | None = None) -> SandboxPolicy:
    """The policy of one command in the project folder ``cwd``.

    Writes: the project folder, the session temp folder, the package caches, the .git folder of the main project
    for a worktree, and filesystem.allowWrite. Never: the protected project paths, ~/.harness, the shell profiles,
    and filesystem.denyWrite. Reads: all, less the Harness secret files and filesystem.denyRead.
    """
    home = home if home is not None else Path.home()
    hh = harness_home()
    files = config.get("filesystem") or {}
    write = [cwd, session_tmp]
    deny_write = [cwd / p for p in PROTECTED_PROJECT_PATHS]
    common = git_common_dir(cwd)
    if common is not None:
        write.append(common)
        deny_write += [common / "hooks", common / "config"]
    write += [home / p for p in CACHE_DIRS if (home / p).is_dir()]
    write += [_user_path(p, cwd, home) for p in files.get("allowWrite", [])]
    if _inside(cwd, hh):
        # A project folder in ~/.harness: deny the settings and the secrets only.
        deny_write += [hh / "settings.json", *(hh / name for name in SECRET_FILES)]
    else:
        deny_write.append(hh)
    deny_write += [home / p for p in HOME_PROFILES]
    deny_write += [_user_path(p, cwd, home) for p in files.get("denyWrite", [])]
    deny_read = [hh / name for name in SECRET_FILES]
    deny_read += [_user_path(p, cwd, home) for p in files.get("denyRead", [])]
    allow_read = [_user_path(p, cwd, home) for p in files.get("allowRead", [])]
    network = config.get("network") or {}
    return SandboxPolicy(
        write_roots=_unique([_real(p) for p in write]),
        deny_write=_unique([_real(p) for p in deny_write]),
        deny_read=_unique([_real(p) for p in deny_read]),
        allow_read=_unique([_real(p) for p in allow_read]),
        network="off",
        allow_local_binding=network.get("allowLocalBinding") is True,
        temp_dir=_real(session_tmp),
    )


def session_temp_dir(cwd: Path, output_dir: Path | None) -> Path:
    """The temp folder of the session. It is not in ~/.harness, because a sandboxed command cannot write there.

    ``output_dir`` is the output folder of the session (tool_output.py). Its parent folder has the session id.
    """
    name = output_dir.parent.name if output_dir is not None else ""
    name = re.sub(r"[^A-Za-z0-9_.-]", "-", name)[:80].strip(".-")
    if not name:
        name = "project-" + hashlib.sha256(str(cwd).encode("utf-8")).hexdigest()[:12]
    return Path(tempfile.gettempdir()) / "harness-sandbox" / name


def prepare_run(cwd: Path, output_dir: Path | None, config: dict[str, Any]) -> SandboxPolicy:
    """Make the folders that a sandboxed command needs, and return its policy."""
    tmp = session_temp_dir(cwd, output_dir)
    tmp.mkdir(parents=True, exist_ok=True)
    if backend_for() == "bubblewrap":
        # bubblewrap protects only paths that exist. A command must not make .harness/settings.json with
        # allow rules, so the folder must exist before the command starts.
        try:
            (cwd / ".harness").mkdir(exist_ok=True)
        except OSError:
            pass
    return policy_for(cwd, tmp, config)


def sandbox_env(policy: SandboxPolicy) -> dict[str, str]:
    """The extra environment of a sandboxed command: the temp folder of the session, and with the network
    "proxy", the proxy variables. Programs that read these variables (curl, git, pip, npm, and others) then
    connect through the proxy. Programs that do not read them get no network."""
    env: dict[str, str] = {}
    if policy.temp_dir:
        env.update({"TMPDIR": policy.temp_dir, "TMP": policy.temp_dir, "TEMP": policy.temp_dir})
    if policy.network == "proxy" and policy.proxy_port:
        url = f"http://127.0.0.1:{policy.proxy_port}"
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            env[name] = url
        env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
        env["NODE_USE_ENV_PROXY"] = "1"  # Node 24 and later: fetch uses the proxy variables.
    return env


# -- excluded commands ---------------------------------------------------------------------------------------

_SEGMENTS = re.compile(r"&&|\|\||[;|&\n]")


def _matches(segment: str, pattern: str) -> bool:
    pattern = pattern.strip()
    if pattern.endswith(":*"):  # The rule form of Harness: "docker:*".
        pattern = pattern[:-2] + " *"
    if pattern.endswith(" *") and "*" not in pattern[:-2]:
        base = pattern[:-2]
        return segment == base or segment.startswith(base + " ")
    if "*" in pattern or "?" in pattern:
        return fnmatch.fnmatchcase(segment, pattern)
    return segment == pattern or segment.startswith(pattern + " ")


def is_excluded(command: str, config: dict[str, Any]) -> bool:
    """True if a part of the command matches excludedCommands. Such a command runs outside the sandbox.

    A pattern "docker compose *" matches "docker compose up". A pattern with no "*" matches the command and the
    command with more arguments. Each part between shell operators (;, &&, ||, |, &) is checked.
    """
    patterns = config.get("excludedCommands") or []
    if not patterns:
        return False
    segments = [s.strip() for s in _SEGMENTS.split(command) if s.strip()]
    return any(_matches(s, p) for s in segments for p in patterns)


# -- the backends --------------------------------------------------------------------------------------------


def _sb_string(path: str) -> str:
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def seatbelt_profile(policy: SandboxPolicy) -> str:
    """The Seatbelt profile (SBPL) for sandbox-exec. All is allowed except the network, writes outside the write
    roots, the deny paths, and the deny-read paths. A later rule wins over an earlier rule."""
    lines = ["(version 1)", "(allow default)"]
    if policy.network != "on":
        lines.append("(deny network*)")
        if policy.allow_local_binding:
            lines += ['(allow network-bind (local ip "localhost:*"))',
                      '(allow network-inbound (local ip "localhost:*"))',
                      '(allow network-outbound (remote ip "localhost:*"))']
        if policy.network == "proxy" and policy.proxy_port:
            # Only the connection to the proxy. The proxy checks the host.
            lines.append(f'(allow network-outbound (remote ip "localhost:{int(policy.proxy_port)}"))')
    lines.append("(deny file-write*)")
    allowed = [f"  (subpath {_sb_string(p)})" for p in policy.write_roots]
    allowed += ['  (literal "/dev/null")', '  (literal "/dev/zero")', '  (literal "/dev/stdout")',
                '  (literal "/dev/stderr")', '  (literal "/dev/tty")', '  (literal "/dev/dtracehelper")',
                '  (regex #"^/dev/ttys[0-9]+$")', '  (subpath "/dev/fd")']
    lines.append("(allow file-write*\n" + "\n".join(allowed) + ")")
    if policy.deny_write:
        lines.append("(deny file-write*\n" + "\n".join(f"  (subpath {_sb_string(p)})" for p in policy.deny_write)
                     + ")")
    if policy.deny_read:
        lines.append("(deny file-read*\n" + "\n".join(f"  (subpath {_sb_string(p)})" for p in policy.deny_read)
                     + ")")
        if policy.allow_read:
            lines.append("(allow file-read*\n"
                         + "\n".join(f"  (subpath {_sb_string(p)})" for p in policy.allow_read) + ")")
    return "\n".join(lines) + "\n"


def bwrap_args(policy: SandboxPolicy, exists: Callable[[str], bool] = os.path.exists,
               is_dir: Callable[[str], bool] = os.path.isdir) -> list[str]:
    """The bubblewrap arguments before "--". bubblewrap mounts only paths that exist, in this order: the root
    read-only, the write roots, the deny-write paths read-only, the deny-read paths hidden, then allowRead."""
    args = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev"]
    for p in policy.write_roots:
        if exists(p):
            args += ["--bind", p, p]
    for p in policy.deny_write:
        if exists(p):
            args += ["--ro-bind", p, p]
    for p in policy.deny_read:
        if not exists(p):
            continue
        args += ["--tmpfs", p, "--remount-ro", p] if is_dir(p) else ["--ro-bind", "/dev/null", p]
    for p in policy.allow_read:
        if exists(p):
            args += ["--ro-bind", p, p]
    if policy.network != "on":
        args.append("--unshare-net")
    return args


# Linux with the network "proxy": the command has its own network namespace with only "lo". This script runs in
# the sandbox before the command. socat listens on 127.0.0.1:<port> and connects each connection to the Unix
# socket of the proxy, which is outside the namespace. The script waits until socat listens (at most 2 seconds),
# runs the command, stops socat, and gives the exit code of the command. The arguments: socat, the socket path,
# the port, then the command.
LINUX_BRIDGE_SCRIPT = (
    'socat=$1; sock=$2; port=$3; shift 3\n'
    '"$socat" TCP-LISTEN:"$port",bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:"$sock" </dev/null >/dev/null 2>&1 &\n'
    'bridge=$!\n'
    'i=0\n'
    'while [ "$i" -lt 100 ] && ! "$socat" -u OPEN:/dev/null TCP:127.0.0.1:"$port" >/dev/null 2>&1; do\n'
    '  i=$((i + 1)); sleep 0.02\n'
    'done\n'
    '"$@"\n'
    'code=$?\n'
    'kill "$bridge" 2>/dev/null\n'
    'exit "$code"\n'
)
LINUX_PROXY_PORT = 3128  # The port of the bridge in the network namespace of the command.


def wrap(argv: list[str], policy: SandboxPolicy, platform: str | None = None,
         exists: Callable[[str], bool] = os.path.exists, is_dir: Callable[[str], bool] = os.path.isdir) -> list[str]:
    """The process arguments that run ``argv`` in the sandbox of the platform."""
    if policy.network not in ("off", "on", "proxy"):
        raise SandboxError(f"The network setting {policy.network!r} is not known.")
    backend = backend_for(platform)
    if backend == "seatbelt":
        if policy.network == "proxy" and not policy.proxy_port:
            raise SandboxError("The network setting 'proxy' needs the port of the proxy.")
        return [SEATBELT_PROGRAM, "-p", seatbelt_profile(policy), *argv]
    if backend == "bubblewrap":
        prefix = [_find_bwrap() or "bwrap", *bwrap_args(policy, exists, is_dir), "--"]
        if policy.network != "proxy":
            return [*prefix, *argv]
        if not (policy.proxy_socket and policy.proxy_port):
            raise SandboxError("The network setting 'proxy' needs the socket and the port of the proxy.")
        return [*prefix, "/bin/sh", "-c", LINUX_BRIDGE_SCRIPT, "harness-sandbox", _find_socat() or "socat",
                policy.proxy_socket, str(int(policy.proxy_port)), *argv]
    raise SandboxError(WINDOWS_REASON if backend == "windows" else OTHER_REASON)
