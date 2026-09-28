"""The Cookbook service of the daemon: one for all connections.

Downloads and served models belong to the daemon, not to one connection. Each connection
that uses the Cookbook gets the events: ``download.progress`` and ``serve.status``.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from ..config import write_json
from ..provider_config import providers_path
from ..providers import read_provider_entries
from .fit import RECOMMEND_CONTEXT, Hardware, estimate_badge, fit, recommend
from .gguf import ModelShape
from .hosts import LOCAL, Host, HostError, ScriptRun, get_host, key_path, run_script, start_script
from .hub import Hub

log = logging.getLogger("harness.cookbook")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

HARDWARE_TTL = 300
SERVE_POLL = 2.0
SERVE_START_TIMEOUT = 600  # Large models load slowly.
DEFAULT_PORT = 8081
MIN_CONTEXT = 4096
MAX_DEFAULT_CONTEXT = 32768


class CookbookError(Exception):
    pass


@dataclass
class Download:
    id: str
    host: str
    repo_id: str
    files: list[str]
    sizes: dict[str, int]
    state: str = "queued"  # queued, running, paused, done, error, cancelled
    done_bytes: int = 0  # The bytes of the complete files.
    current: int = 0  # The bytes of the file that downloads now.
    file: str | None = None
    error: str | None = None
    run: ScriptRun | None = None
    finished: set[str] = field(default_factory=set)
    started: float = field(default_factory=time.time)

    @property
    def total(self) -> int:
        return sum(self.sizes.values())

    def event(self) -> dict[str, Any]:
        return {"type": "download.progress", "id": self.id, "host": self.host, "repo_id": self.repo_id,
                "files": self.files, "state": self.state, "bytes_done": self.done_bytes + self.current,
                "bytes_total": self.total, "file": self.file, "error": self.error, "started": self.started}


def _safe(text: str, limit: int = 40) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-.")[:limit] or "model"


class Cookbook:
    def __init__(self) -> None:
        self.hub = Hub()
        self.listeners: set[Emit] = set()
        self.hardware: dict[str, tuple[float, dict[str, Any]]] = {}
        self.downloads: dict[str, Download] = {}
        self.starting: set[tuple[str, str]] = set()  # (host, serve name) that start now.

    # -- events --------------------------------------------------------------------------------

    def listen(self, emit: Emit) -> None:
        self.listeners.add(emit)

    def unlisten(self, emit: Emit) -> None:
        self.listeners.discard(emit)

    async def broadcast(self, message: dict[str, Any]) -> None:
        for emit in list(self.listeners):
            try:
                await emit(message)
            except Exception:  # noqa: BLE001 - a closed connection.
                self.listeners.discard(emit)

    # -- hardware ------------------------------------------------------------------------------

    async def get_hardware(self, host_name: str | None, refresh: bool = False) -> dict[str, Any]:
        host = get_host(host_name)
        cached = self.hardware.get(host.name)
        if cached and not refresh and time.time() - cached[0] < HARDWARE_TTL:
            return cached[1]
        info = await run_script(host, "hardware")
        self.hardware[host.name] = (time.time(), info)
        return info

    async def _hw(self, host_name: str | None) -> Hardware | None:
        try:
            return Hardware.from_json(await self.get_hardware(host_name))
        except (HostError, CookbookError) as e:
            log.info("No hardware for the fit check: %s", e)
            return None

    # -- the model browser -----------------------------------------------------------------------

    async def search(self, msg: dict[str, Any]) -> dict[str, Any]:
        filters = msg.get("filters") if isinstance(msg.get("filters"), dict) else {}
        page = max(0, int(msg.get("page") or 0))
        items, has_more = await self.hub.search(
            str(msg.get("query") or ""), str(filters.get("library") or "gguf"),
            filters.get("task", "text-generation"), filters.get("params") or None,
            str(msg.get("sort") or "downloads"), page)
        hw = await self._hw(msg.get("host"))
        out = []
        for item in items:
            badge = estimate_badge(item["params"], hw)
            out.append({**item, "fit": badge["result"] if badge else None})
        if filters.get("fit_only") and hw is not None:
            out = [i for i in out if i["fit"] in ("fits", "offload")]
        return {"type": "hf.results", "items": out, "page": page, "has_more": has_more,
                "query": msg.get("query") or "", "hardware": hw is not None}

    async def detail(self, repo_id: str, host_name: str | None) -> dict[str, Any]:
        detail = await self.hub.detail(repo_id)
        hw = await self._hw(host_name)
        shape: ModelShape | None = detail["_shape"]
        groups = []
        for group in detail["groups"]:
            result = fit(group["size"], shape, hw, RECOMMEND_CONTEXT, detail["item"]["params"]) if hw else None
            groups.append({**group, "fit": result})
        body = {k: v for k, v in detail.items() if not k.startswith("_") and k != "groups"}
        return {"type": "hf.detail", **body, "files": groups, "recommended": recommend(groups) if hw else None,
                "host": host_name or LOCAL, "hardware": hw is not None}

    # -- downloads ------------------------------------------------------------------------------------

    async def start_download(self, host_name: str | None, repo_id: str, files: list[str]) -> Download:
        host = get_host(host_name)
        if not files:
            raise CookbookError("Select one or more files.")
        detail = await self.hub.detail(repo_id)
        if detail["gated"] and not detail["access"]:
            raise CookbookError(f"No access to {repo_id}. Accept the license on {detail['url']}, and add a Hugging "
                                "Face token in the settings of the Local Models screen.")
        known: dict[str, int] = detail["_sizes"]
        missing = [name for name in files if name not in known]
        if missing:
            raise CookbookError(f"The file {missing[0]} is not in {repo_id}.")
        sizes = {name: known[name] for name in files}
        for d in self.downloads.values():
            if d.host == host.name and d.repo_id == repo_id and set(d.files) == set(files) and d.state in ("queued", "running"):
                return d
        download = Download(uuid.uuid4().hex[:10], host.name, repo_id, list(files), sizes)
        self.downloads[download.id] = download
        await self._run_download(download)
        return download

    async def _run_download(self, d: Download) -> None:
        host = get_host(d.host)
        remaining = [f for f in d.files if f not in d.finished]
        d.state, d.error, d.current = "running", None, 0

        def on_event(event: dict[str, Any]) -> None:
            kind = event.get("event")
            if kind == "file":
                d.file, d.current = event.get("file"), 0
            elif kind == "progress":
                d.current = int(event.get("done") or 0)
                if event.get("total"):
                    d.sizes[event["file"]] = int(event["total"])
            elif kind == "file_done":
                d.finished.add(event["file"])
                d.done_bytes += int(event.get("size") or d.sizes.get(event["file"], 0))
                d.current = 0
            asyncio.ensure_future(self.broadcast(d.event()))

        try:
            d.run = start_script(host, "download", {"repo_id": d.repo_id, "files": remaining,
                                                     "token": self.hub.token}, on_event)
        except HostError as e:
            d.state, d.error = "error", str(e)
            await self.broadcast(d.event())
            return
        await self.broadcast(d.event())
        asyncio.ensure_future(self._watch_download(d, d.run))

    async def _watch_download(self, d: Download, run: ScriptRun) -> None:
        try:
            await run.done
            d.state, d.file, d.current = "done", None, 0
            d.done_bytes = d.total
        except HostError as e:
            if run.killed:
                return  # pause or cancel set the state.
            d.state, d.error = "error", str(e)
        await self.broadcast(d.event())

    def get_download(self, download_id: str) -> Download:
        d = self.downloads.get(download_id)
        if d is None:
            raise CookbookError(f"Unknown download: {download_id}")
        return d

    async def pause(self, download_id: str) -> None:
        d = self.get_download(download_id)
        if d.state != "running":
            return
        d.state = "paused"
        if d.run:
            await asyncio.to_thread(d.run.kill)
        await self.broadcast(d.event())

    async def resume(self, download_id: str) -> None:
        d = self.get_download(download_id)
        if d.state in ("paused", "error"):
            await self._run_download(d)  # hf_hub_download continues from the .incomplete file.

    async def cancel(self, download_id: str) -> None:
        d = self.get_download(download_id)
        if d.state in ("done", "cancelled"):
            return
        previous = d.state
        d.state = "cancelled"
        if d.run and previous == "running":
            await asyncio.to_thread(d.run.kill)
        try:
            await run_script(get_host(d.host), "cleanup", {"repo_id": d.repo_id})
        except HostError as e:
            d.error = f"The unfinished files were not removed: {e}"
        await self.broadcast(d.event())

    def download_items(self) -> list[dict[str, Any]]:
        return [d.event() for d in sorted(self.downloads.values(), key=lambda d: d.started, reverse=True)]

    def stop_all(self) -> None:
        """Stop the running downloads. For a daemon that stops. They can continue after a new start."""
        for d in self.downloads.values():
            if d.run and d.state == "running":
                d.run.kill()

    # -- installed models ---------------------------------------------------------------------------

    async def installed(self, host_name: str | None) -> dict[str, Any]:
        host = get_host(host_name)
        result = await run_script(host, "installed")
        return {"type": "installed", "host": host.name, **result}

    async def delete(self, host_name: str | None, repo_id: str, files: list[str]) -> None:
        host = get_host(host_name)
        for d in self.downloads.values():
            if d.host == host.name and d.repo_id == repo_id and d.state == "running":
                raise CookbookError("A download of this model runs now. Pause or cancel it first.")
        await run_script(host, "delete", {"repo_id": repo_id, "files": files})

    async def delete_other(self, host_name: str | None, source: str, name: str) -> None:
        """Delete a model of Ollama ("ollama rm") or of LM Studio (its folder) on the host."""
        host = get_host(host_name)
        if source == "ollama":
            await run_script(host, "delete-ollama", {"name": name})
        elif source == "lmstudio":
            await run_script(host, "delete-lmstudio", {"id": name})
        else:
            raise CookbookError(f"Unknown model source: {source}.")

    # -- serve control ----------------------------------------------------------------------------------

    async def serves(self, host_name: str | None) -> dict[str, Any]:
        host = get_host(host_name)
        result = await run_script(host, "serve-status")
        items = []
        for s in result["serves"]:
            state = "running" if s["ready"] else "starting" if s["alive"] else "crashed"
            if (host.name, s["name"]) in self.starting and state == "crashed":
                state = "starting"
            items.append({**s, "state": state, "provider": provider_name(host, s["port"])})
        return {"type": "serves", "host": host.name, "items": items}

    async def serve_start(self, msg: dict[str, Any]) -> dict[str, Any]:
        host = get_host(msg.get("host"))
        repo_id = str(msg.get("repo_id") or "")
        file = str(msg.get("file") or "")
        if not repo_id or not file.endswith(".gguf"):
            raise CookbookError("llama-server serves GGUF files. Select a GGUF file.")
        found = await run_script(host, "resolve", {"repo_id": repo_id, "file": file})
        if not found.get("path"):
            raise CookbookError(f"{file} is not downloaded on the host {host.name}. Download it first.")
        info = await self.get_hardware(host.name)
        hw = Hardware.from_json(info) or Hardware(0, 0)
        if not info.get("llama_server"):
            raise CookbookError(f"llama-server is not on the host {host.name}. Install llama.cpp, or set the "
                                "llama-server path of the host in the Local Models screen.")
        detail = await self.hub.detail(repo_id)
        shape: ModelShape | None = detail["_shape"]
        group = next((g for g in detail["groups"] if file in g["files"]), None)
        weights = group["size"] if group else 0
        context = int(msg.get("context") or 0) or default_context(weights, shape, hw)
        result = fit(weights, shape, hw, context, detail["item"]["params"])
        if result["result"] == "no":
            raise CookbookError(f"The model does not fit on {host.name} with a context of {context} tokens. "
                                "Select a smaller quant or a smaller context.")
        existing = (await self.serves(host.name))["items"]
        port = int(msg.get("port") or 0) or next_port(existing)
        name = _safe(f"{repo_id.split('/')[-1]}-{group['quant'] if group and group['quant'] else 'model'}".lower())
        if any(s["name"] == name for s in existing):
            raise CookbookError(f"{name} already runs on {host.name}. Stop it first.")
        alias = name
        state = await run_script(host, "serve-start", {
            "name": name, "model_path": found["path"], "port": port, "context": context,
            "gpu_layers": result.get("gpu_layers", 999 if result["result"] == "fits" else 0), "alias": alias,
            "repo_id": repo_id, "file": file})
        self.starting.add((host.name, name))
        asyncio.ensure_future(self._watch_start(host, name, port, alias, context))
        status = {"type": "serve.status", "host": host.name, "name": name, "state": "starting", "port": port,
                  "context": context, "gpu_layers": state.get("gpu_layers"), "fit": result["result"],
                  "provider": provider_name(host, port)}
        await self.broadcast(status)
        return status

    async def _watch_start(self, host: Host, name: str, port: int, alias: str, context: int) -> None:
        deadline = time.time() + SERVE_START_TIMEOUT
        state = "crashed"
        try:
            while time.time() < deadline:
                await asyncio.sleep(SERVE_POLL)
                try:
                    serves = (await run_script(host, "serve-status"))["serves"]
                except HostError:
                    continue
                s = next((x for x in serves if x["name"] == name), None)
                if s is None or not s["alive"]:
                    state = "crashed"
                    break
                if s["ready"] and await self._healthy(host, port):
                    state = "running"
                    break
            else:
                state = "starting"
        finally:
            self.starting.discard((host.name, name))
        body: dict[str, Any] = {"type": "serve.status", "host": host.name, "name": name, "state": state, "port": port}
        if state == "running":
            body["provider"] = add_provider(host, port, alias, context)
            body["model"] = f"{body['provider']}/{alias}"
        elif state == "crashed":
            body["error"] = "llama-server stopped. Read its log."
        await self.broadcast(body)

    async def _healthy(self, host: Host, port: int) -> bool:
        """llama-server answers /health with 200 when the model is loaded."""
        if host.remote:
            return True  # The port check of the host script is enough. A tunnel opens on the first model call.
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                return (await client.get(f"http://127.0.0.1:{port}/health")).status_code == 200
        except httpx.HTTPError:
            return False

    async def serve_stop(self, host_name: str | None, name: str) -> None:
        host = get_host(host_name)
        serves = (await run_script(host, "serve-status"))["serves"]
        state = next((s for s in serves if s["name"] == name), None)
        await run_script(host, "serve-stop", {"name": name})
        if state:
            remove_provider(host, state["port"])
        await self.broadcast({"type": "serve.status", "host": host.name, "name": name, "state": "stopped"})

    async def serve_output(self, host_name: str | None, name: str) -> dict[str, Any]:
        host = get_host(host_name)
        result = await run_script(host, "serve-log", {"name": name, "lines": 300})
        return {"type": "serve.output", "host": host.name, "name": name, "text": result["text"]}


def default_context(weights: int, shape: ModelShape | None, hw: Hardware) -> int:
    """The largest context that fits in VRAM, from 4096 to 32768 tokens. 8192 for CPU offload."""
    probe = fit(weights, shape, hw, MIN_CONTEXT)
    best = probe["max_context_vram"]
    if best >= MIN_CONTEXT:
        limit = min(best, MAX_DEFAULT_CONTEXT, shape.context_length if shape and shape.context_length else MAX_DEFAULT_CONTEXT)
        return max(MIN_CONTEXT, limit // 1024 * 1024)
    return 8192


def next_port(serves: list[dict[str, Any]]) -> int:
    used = {int(s["port"]) for s in serves}
    port = DEFAULT_PORT
    while port in used:
        port += 1
    return port


def provider_name(host: Host, port: int) -> str:
    return f"{host.name}-llama-{port}"


def add_provider(host: Host, port: int, alias: str, context: int) -> str:
    """Add the served model to providers.json. A remote host gets an SSH tunnel."""
    entries, _ = read_provider_entries()
    name = provider_name(host, port)
    entry: dict[str, Any] = {"base_url": f"http://127.0.0.1:{port}/v1", "api_key": "none", "kind": "openai",
                             "context_length": context, "models": {alias: {"context_length": context}},
                             "cookbook": True}
    if host.ssh:
        ssh: dict[str, Any] = {"host": host.ssh.host}
        if host.ssh.user:
            ssh["user"] = host.ssh.user
        if host.ssh.port:
            ssh["port"] = host.ssh.port
        identity = host.ssh.identity_file or (str(key_path()) if key_path().exists() else None)
        if identity:
            ssh["identity_file"] = identity
        entry["ssh"] = ssh
    entries[name] = entry
    write_json(providers_path(), entries)
    return name


def remove_provider(host: Host, port: int) -> None:
    entries, exists = read_provider_entries()
    name = provider_name(host, port)
    if exists and isinstance(entries.get(name), dict) and entries[name].get("cookbook") and len(entries) > 1:
        del entries[name]
        write_json(providers_path(), entries)


COOKBOOK = Cookbook()
