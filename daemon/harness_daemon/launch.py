"""The server configuration: ``<project>/.harness/launch.json`` (SPEC.md section 8.7).

    { "servers": [ { "name": "web", "command": "npm run dev", "cwd": ".", "port": 5173,
                     "ready_pattern": "Local:.*http", "env": {"NODE_ENV": "development"},
                     "default": true } ] }

If the file does not exist, ``propose`` reads the project and proposes a configuration.
The daemon writes the file only after the user approves the proposal.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .config import ConfigError, read_json, write_json
from .files import PathError, resolve_in_cwd

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$")
# Folders to check for a second project, for example "frontend" and "backend".
SUB_PROJECT_DIRS = ("frontend", "backend", "web", "client", "server", "app", "api", "site", "ui")


@dataclass
class ServerConfig:
    name: str
    command: str
    cwd: str = "."
    port: int | None = None
    ready_pattern: str | None = None
    health_url: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    default: bool = False

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        return {k: v for k, v in data.items() if v not in (None, {}, False) or k in ("name", "command", "cwd")}


def launch_path(project: Path) -> Path:
    return Path(project) / ".harness" / "launch.json"


def _parse_server(raw: Any, index: int) -> ServerConfig:
    if not isinstance(raw, dict):
        raise ConfigError(f"launch.json: server {index + 1} must be an object.")
    name = raw.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ConfigError(f"launch.json: server {index + 1} needs a 'name' of letters, digits, '.', '_', or '-'.")
    command = raw.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ConfigError(f"launch.json: server '{name}' needs a 'command'.")
    port = raw.get("port")
    if port is not None and (not isinstance(port, int) or not 1 <= port <= 65535):
        raise ConfigError(f"launch.json: server '{name}' has a port that is not valid: {port!r}")
    pattern = raw.get("ready_pattern")
    if pattern is not None:
        try:
            re.compile(pattern)
        except (re.error, TypeError) as e:
            raise ConfigError(f"launch.json: the ready_pattern of '{name}' is not valid: {e}") from None
    env = raw.get("env") or {}
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, (str, int, float)) for k, v in env.items()):
        raise ConfigError(f"launch.json: the env of '{name}' must map names to text values.")
    health = raw.get("health_url")
    if health is not None and (not isinstance(health, str) or not re.match(r"^https?://", health)):
        raise ConfigError(f"launch.json: the health_url of '{name}' must start with http:// or https://.")
    return ServerConfig(
        name=name,
        command=command.strip(),
        cwd=str(raw.get("cwd") or "."),
        port=port,
        ready_pattern=pattern,
        health_url=health,
        env={k: str(v) for k, v in env.items()},
        default=bool(raw.get("default")),
    )


def load_launch(project: Path) -> list[ServerConfig] | None:
    """The servers of the project, or None if launch.json does not exist."""
    data = read_json(launch_path(project), None)
    if data is None:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("servers"), list):
        raise ConfigError("launch.json must be an object with a 'servers' list.")
    return _parse_all(project, data["servers"])


def _parse_all(project: Path, raw_servers: list[Any]) -> list[ServerConfig]:
    servers = [_parse_server(raw, i) for i, raw in enumerate(raw_servers)]
    names = [s.name for s in servers]
    duplicates = {n for n in names if names.count(n) > 1}
    if duplicates:
        raise ConfigError(f"launch.json: two servers have the same name: {', '.join(sorted(duplicates))}")
    for s in servers:
        server_dir(project, s)  # Rejects a cwd outside the project.
    return servers


def save_launch(project: Path, servers: list[dict[str, Any]]) -> list[ServerConfig]:
    """Check the servers and write launch.json. Return the parsed servers."""
    parsed = _parse_all(project, servers)
    write_json(launch_path(project), {"servers": [s.to_json() for s in parsed]})
    return parsed


def server_dir(project: Path, server: ServerConfig) -> Path:
    try:
        folder = resolve_in_cwd(project, server.cwd or ".")
    except PathError as e:
        raise ConfigError(f"launch.json: the cwd of '{server.name}' is outside the project.") from e
    return folder


# -- proposal -------------------------------------------------------------------------


def _package_manager(folder: Path) -> str:
    if (folder / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (folder / "yarn.lock").exists():
        return "yarn"
    if (folder / "bun.lockb").exists() or (folder / "bun.lock").exists():
        return "bun"
    return "npm"


def _read_text(path: Path, limit: int = 200_000) -> str:
    try:
        return path.read_bytes()[:limit].decode("utf-8", errors="replace")
    except OSError:
        return ""


def _detect(folder: Path) -> ServerConfig | None:
    """One server for one folder, from the table of SPEC.md section 8.7."""
    names = {p.name for p in folder.iterdir()} if folder.is_dir() else set()
    package = folder / "package.json"
    if package.is_file():
        try:
            scripts = json.loads(_read_text(package)).get("scripts") or {}
        except (ValueError, AttributeError):
            scripts = {}
        if isinstance(scripts, dict) and "dev" in scripts:
            dev = str(scripts["dev"])
            manager = _package_manager(folder)
            command = f"{manager} run dev" if manager in ("npm", "pnpm", "bun") else "yarn dev"
            if "next" in dev:
                return ServerConfig("web", command, port=3000, ready_pattern=r"Ready|ready|started server")
            if "vite" in dev or any(n.startswith("vite.config.") for n in names):
                return ServerConfig("web", command, port=5173, ready_pattern=r"Local:.*http")
            return ServerConfig("web", command, port=None, ready_pattern=r"https?://(localhost|127\.0\.0\.1|\[::1\]):\d+")
    if any(n.startswith("vite.config.") for n in names):
        return ServerConfig("web", "npx vite", port=5173, ready_pattern=r"Local:.*http")
    if any(n.startswith("next.config.") for n in names):
        return ServerConfig("web", "npx next dev", port=3000, ready_pattern=r"Ready|ready|started server")
    if "manage.py" in names:
        return ServerConfig("api", "python manage.py runserver", port=8000, ready_pattern=r"Starting development server")
    for entry in ("main.py", "app.py"):
        if entry in names:
            text = _read_text(folder / entry)
            module = entry[:-3]
            if re.search(r"\bFastAPI\s*\(", text):
                return ServerConfig("api", f"uvicorn {module}:app --reload --port 8000", port=8000,
                                    ready_pattern=r"Uvicorn running|Application startup complete")
            if entry == "app.py" and re.search(r"\bFlask\s*\(", text):
                return ServerConfig("api", "flask run", port=5000, ready_pattern=r"Running on")
    if "index.html" in names:
        # --bind: the other computers on the network cannot reach the project files.
        return ServerConfig("site", "python -m http.server 8080 --bind 127.0.0.1", port=8080, ready_pattern=r"Serving HTTP")
    return None


def propose(project: Path) -> list[ServerConfig]:
    """Propose servers for a project with no launch.json: the project folder and its common subfolders."""
    project = Path(project)
    found: list[ServerConfig] = []
    root = _detect(project)
    if root:
        found.append(root)
    for sub in SUB_PROJECT_DIRS:
        folder = project / sub
        if folder.is_dir():
            server = _detect(folder)
            if server:
                server.cwd = sub
                found.append(server)
    # Unique names: "web", then "web-2", and so on.
    seen: dict[str, int] = {}
    for s in found:
        count = seen.get(s.name, 0) + 1
        seen[s.name] = count
        if count > 1:
            s.name = f"{s.name}-{count}"
    if found:
        found[0].default = True
    return found
