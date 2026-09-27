"""Tests for the Cookbook (build phase 11): GGUF headers, the fit calculator, hosts, downloads, and serve control.

The tests use no network: a fake Hugging Face file server (HF_ENDPOINT), a fake llama-server,
and a fake ssh program that runs the remote command on this computer.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from harness_daemon import tunnels
from harness_daemon.cookbook import hosts as hosts_mod
from harness_daemon.cookbook.fit import Hardware, estimate_badge, fit, gpu_layers, quant_of, recommend, split_key
from harness_daemon.cookbook.gguf import NeedMore, parse_metadata, read_local_shape, shape_from_metadata
from harness_daemon.cookbook.hosts import Host, run_script
from harness_daemon.cookbook.hub import group_files, shape_from_config
from harness_daemon.cookbook.service import Cookbook, default_context

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

PYTHON = Path(getattr(sys, "_base_executable", sys.executable))
VENV_PYTHON = Path(sys.executable)
TESTS = Path(__file__).parent
GB = 1024 ** 3
COMMIT = "a" * 40


# -- GGUF headers -------------------------------------------------------------------------------------


def _string(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<Q", len(raw)) + raw


def gguf_bytes(arch: str = "llama", layers: int = 4, heads: int = 8, kv_heads: int = 2, embedding: int = 256,
               context: int = 4096, vocab: int = 1000) -> bytes:
    kv: list[tuple[str, int, bytes]] = [
        ("general.architecture", 8, _string(arch)),
        (f"{arch}.block_count", 4, struct.pack("<I", layers)),
        (f"{arch}.attention.head_count", 4, struct.pack("<I", heads)),
        (f"{arch}.attention.head_count_kv", 4, struct.pack("<I", kv_heads)),
        (f"{arch}.embedding_length", 4, struct.pack("<I", embedding)),
        (f"{arch}.context_length", 4, struct.pack("<I", context)),
        ("general.tags", 9, struct.pack("<IQ", 8, 2) + _string("a") + _string("b")),
        ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, vocab) + b"".join(_string(f"t{i}") for i in range(vocab))),
    ]
    out = b"GGUF" + struct.pack("<IQQ", 3, 0, len(kv))
    for key, kind, value in kv:
        out += _string(key) + struct.pack("<I", kind) + value
    return out


def test_gguf_header(tmp_path):
    data = gguf_bytes()
    shape = shape_from_metadata(parse_metadata(data))
    assert (shape.architecture, shape.layers, shape.kv_heads, shape.head_dim, shape.context_length) == ("llama", 4, 2, 32, 4096)
    # 2 (K and V) × 4 layers × 2 KV heads × 32 × 2 bytes.
    assert shape.kv_bytes_per_token() == 2 * 4 * 2 * 32 * 2
    with pytest.raises(NeedMore):
        parse_metadata(data[:60])
    path = tmp_path / "m.gguf"
    path.write_bytes(data + b"\0" * 100)
    assert read_local_shape(str(path)).layers == 4


# -- the fit calculator ------------------------------------------------------------------------------------


def test_fit_results():
    shape = shape_from_metadata(parse_metadata(gguf_bytes(layers=32, heads=32, kv_heads=8, embedding=4096, context=131072)))
    per_token = shape.kv_bytes_per_token()  # 131072 bytes for a Llama-3-8B shape.
    assert per_token == 2 * 32 * 8 * 128 * 2
    gpu = Hardware(vram=24 * GB, ram=32 * GB)
    result = fit(5 * GB, shape, gpu, 16384)
    assert result["result"] == "fits" and result["kv_cache"] == per_token * 16384
    assert result["total"] == int((5 * GB + per_token * 16384) * 1.1)
    # The VRAM allows 137774 tokens. The model context (131072) is the limit.
    assert int((24 * GB / 1.1 - 5 * GB) // per_token) == 137774 and result["max_context_vram"] == 131072
    assert fit(5 * GB, shape, Hardware(vram=12 * GB, ram=0), 16384)["max_context_vram"] == int((12 * GB / 1.1 - 5 * GB) // per_token)
    assert result["gpu_layers"] == 32

    small = Hardware(vram=4 * GB, ram=32 * GB)
    offload = fit(5 * GB, shape, small, 16384)
    assert offload["result"] == "offload" and offload["max_context_vram"] == 0
    assert 0 < offload["gpu_layers"] < 32
    assert fit(60 * GB, shape, small, 16384)["result"] == "no"
    assert fit(1 * GB, shape, Hardware(vram=0, ram=16 * GB), 4096)["result"] == "offload"  # No GPU.
    assert gpu_layers(10 * GB, 0, 40, Hardware(vram=0, ram=GB)) == 0

    assert estimate_badge(8_000_000_000, gpu)["result"] == "fits"
    assert estimate_badge(70_000_000_000, small)["result"] == "no"
    assert estimate_badge(None, gpu) is None

    groups = [{"name": "q4", "size": 4, "fit": {"result": "fits"}}, {"name": "q8", "size": 8, "fit": {"result": "fits"}},
              {"name": "f16", "size": 16, "fit": {"result": "offload"}}]
    assert recommend(groups) == "q8"
    assert default_context(5 * GB, shape, gpu) == 32768
    assert default_context(5 * GB, shape, small) == 8192


def test_quant_names_and_split_files():
    assert quant_of("qwen2.5-coder-7b-instruct-q4_k_m-00001-of-00002.gguf") == "Q4_K_M"
    assert quant_of("Qwen3-30B-A3B-UD-Q4_K_XL.gguf") == "UD-Q4_K_XL"
    assert quant_of("Q8_0/model-00001-of-00002.gguf") == "Q8_0"
    assert quant_of("model-IQ4_XS.gguf") == "IQ4_XS" and quant_of("m-bf16.gguf") == "BF16"
    assert split_key("a-q4_k_m-00002-of-00003.gguf") == ("a-q4_k_m.gguf", 2, 3)
    groups = group_files([
        ("m-q4_k_m.gguf", 4), ("m-q4_k_m-00001-of-00002.gguf", 3), ("m-q4_k_m-00002-of-00002.gguf", 1),
        ("m-f16.gguf", 16), ("mmproj-m-f16.gguf", 1), ("README.md", 1),
    ])
    assert [(g["label"], g["size"], len(g["files"])) for g in groups] == [
        ("m-q4_k_m.gguf", 4, 1), ("m-q4_k_m.gguf (2 parts)", 4, 2), ("m-f16.gguf", 16, 1)]
    assert groups[1]["name"] == "m-q4_k_m-00001-of-00002.gguf"
    [st] = group_files([("model-00001-of-00002.safetensors", 5), ("model-00002-of-00002.safetensors", 5)])
    assert (st["size"], st["parts"], st["format"]) == (10, 2, "safetensors")
    shape = shape_from_config({"model_type": "qwen2", "num_hidden_layers": 28, "num_attention_heads": 28,
                               "num_key_value_heads": 4, "hidden_size": 3584, "max_position_embeddings": 32768})
    assert (shape.layers, shape.kv_heads, shape.head_dim) == (28, 4, 128)


# -- hosts -----------------------------------------------------------------------------------------------------


def test_local_hardware_and_remote_host_through_ssh(harness_home, tmp_path, monkeypatch):
    log = tmp_path / "ssh.log"
    monkeypatch.setattr(tunnels, "SSH_COMMAND", [str(VENV_PYTHON), str(TESTS / "fake_ssh_exec.py")])
    monkeypatch.setenv("FAKE_SSH_LOG", str(log))
    hosts_mod.save_host("box", "drew@box:2222", str(VENV_PYTHON), None)
    hosts = hosts_mod.load_hosts()
    assert list(hosts) == ["local", "box"] and hosts["box"].remote

    async def main() -> None:
        local = await run_script(hosts["local"], "hardware")
        assert local["cpu_cores"] > 0 and local["ram_total"] > 0 and isinstance(local["gpus"], list)
        remote = await run_script(hosts["box"], "hardware")
        assert remote["hostname"] == local["hostname"]  # The fake ssh runs on this computer.

    asyncio.run(main())
    args = json.loads(log.read_text().splitlines()[0])
    assert "BatchMode=yes" in args and args[args.index("-p") + 1] == "2222"
    assert args[args.index("--") + 1:] == ["drew@box", str(VENV_PYTHON), "-"]
    with pytest.raises(hosts_mod.HostError):
        hosts_mod.save_host("bad name", "x", None, None)
    with pytest.raises(hosts_mod.HostError):
        hosts_mod.delete_host("local")


def test_ssh_key(harness_home):
    if not any((Path(p) / name).exists() for p in os.environ.get("PATH", "").split(os.pathsep)
               for name in ("ssh-keygen", "ssh-keygen.exe")):
        pytest.skip("ssh-keygen is not installed.")
    assert hosts_mod.public_key() is None
    key = hosts_mod.public_key(create=True)
    assert key.startswith("ssh-ed25519 ") and key == hosts_mod.public_key()
    assert "-i" in Host("box", tunnels.parse_ssh("box")).argv()


# -- a fake Hugging Face file server --------------------------------------------------------------------------


class FakeHub:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.delay = 0.0  # Seconds for each chunk: slow downloads for the pause test.
        self.app = FastAPI()
        self.port = 0

        @self.app.api_route("/{org}/{repo}/resolve/{rev}/{path:path}", methods=["GET", "HEAD"])
        async def resolve(org: str, repo: str, rev: str, path: str, request: Request):
            data = self.files.get(f"{org}/{repo}/{path}")
            if data is None:
                return Response(status_code=404, headers={"x-error-code": "EntryNotFound"})
            etag = '"' + hashlib.sha256(data).hexdigest() + '"'
            headers = {"x-repo-commit": COMMIT, "etag": etag, "accept-ranges": "bytes"}
            if request.method == "HEAD":
                return Response(headers={**headers, "content-length": str(len(data))})
            start = 0
            rng = request.headers.get("range")
            if rng and rng.startswith("bytes="):
                start = int(rng[6:].split("-")[0] or 0)
            body = data[start:]

            async def chunks():
                for i in range(0, len(body), 32768):
                    if self.delay:
                        await asyncio.sleep(self.delay)
                    yield body[i:i + 32768]

            status = 206 if start else 200
            headers["content-length"] = str(len(body))
            if start:
                headers["content-range"] = f"bytes {start}-{len(data) - 1}/{len(data)}"
            return StreamingResponse(chunks(), status_code=status, headers=headers)

    def start(self) -> "FakeHub":
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        self.port = sock.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(self.app, log_level="warning"))
        threading.Thread(target=self.server.run, kwargs={"sockets": [sock]}, daemon=True).start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        self.server.should_exit = True


@pytest.fixture
def hub_env(harness_home, tmp_path, monkeypatch):
    hub = FakeHub().start()
    monkeypatch.setenv("HF_ENDPOINT", f"http://127.0.0.1:{hub.port}")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hf-cache"))
    monkeypatch.setenv("HF_HUB_DISABLE_TELEMETRY", "1")
    monkeypatch.setenv("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    yield hub
    hub.stop()


REPO = "org/tiny-GGUF"


def fake_detail(files: dict[str, bytes], params: int = 100_000_000) -> dict:
    shape = shape_from_metadata(parse_metadata(gguf_bytes()))
    sizes = {name: len(data) for name, data in files.items()}
    return {"repo_id": REPO, "url": f"https://huggingface.co/{REPO}", "item": {"params": params},
            "groups": group_files(list(sizes.items())), "card": "# Tiny", "gated": False, "access": True,
            "shape": shape.to_json(), "shape_error": None, "_shape": shape, "_sizes": sizes}


def make_cookbook(files: dict[str, bytes]) -> tuple[Cookbook, list[dict]]:
    cookbook = Cookbook()
    events: list[dict] = []
    detail = fake_detail(files)

    async def fake_detail_fn(repo_id: str) -> dict:
        return detail

    async def listen(event: dict) -> None:
        events.append(event)

    cookbook.hub.detail = fake_detail_fn  # type: ignore[method-assign]
    cookbook.listen(listen)
    return cookbook, events


async def wait_for(check, timeout: float = 30, what: str = "the condition") -> None:
    deadline = time.time() + timeout
    while not check():
        if time.time() > deadline:
            raise AssertionError(f"Timeout: {what}")
        await asyncio.sleep(0.05)


def test_download_pause_resume_cancel_installed_and_delete(hub_env, tmp_path):
    model = gguf_bytes() + os.urandom(1024 * 1024)
    parts = {f"{REPO}/tiny-q4_k_m-00001-of-00002.gguf": model[:600_000],
             f"{REPO}/tiny-q4_k_m-00002-of-00002.gguf": model[600_000:],
             f"{REPO}/tiny-f16.gguf": model + model}
    hub_env.files.update(parts)
    files = {k.split("/", 2)[2]: v for k, v in parts.items()}
    cookbook, events = make_cookbook(files)
    split = ["tiny-q4_k_m-00001-of-00002.gguf", "tiny-q4_k_m-00002-of-00002.gguf"]

    async def main() -> None:
        # The parts of a split file are one download.
        d = await cookbook.start_download("local", REPO, split)
        assert d.total == len(model)
        await wait_for(lambda: d.state in ("done", "error"), what="the download")
        assert d.state == "done", d.error
        assert events[-1]["bytes_done"] == events[-1]["bytes_total"] == len(model)

        # Pause and continue: the download continues from the .incomplete file.
        hub_env.delay = 0.05
        big = await cookbook.start_download("local", REPO, ["tiny-f16.gguf"])
        await wait_for(lambda: big.current > 0, what="the first bytes")
        await cookbook.pause(big.id)
        assert big.state == "paused"
        incomplete = list((tmp_path / "hf-cache").rglob("*.incomplete"))
        assert incomplete and incomplete[0].stat().st_size > 0
        hub_env.delay = 0
        await cookbook.resume(big.id)
        await wait_for(lambda: big.state in ("done", "error"), what="the resumed download")
        assert big.state == "done", big.error

        installed = await cookbook.installed("local")
        [repo] = installed["repos"]
        assert repo["repo_id"] == REPO and sorted(f["name"] for f in repo["files"]) == sorted([*split, "tiny-f16.gguf"])
        assert repo["size"] == 3 * len(model)

        # Cancel removes the unfinished file.
        await cookbook.delete("local", REPO, ["tiny-f16.gguf"])
        hub_env.delay = 0.05
        again = await cookbook.start_download("local", REPO, ["tiny-f16.gguf"])
        await wait_for(lambda: again.current > 0, what="the first bytes")
        await cookbook.cancel(again.id)
        assert again.state == "cancelled"
        assert not list((tmp_path / "hf-cache").rglob("*.incomplete"))

        await cookbook.delete("local", REPO, split)
        assert (await cookbook.installed("local"))["repos"] == []

    asyncio.run(main())


def fake_llama_command(tmp_path: Path) -> str:
    """A llama-server setting with arguments: Python and the fake server script."""
    return f'"{PYTHON.as_posix()}" "{(TESTS / "fake_llama_server.py").as_posix()}"'


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_serve_start_log_provider_and_stop(hub_env, harness_home, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))  # The serve state of the host script.
    model = gguf_bytes() + b"\0" * 4096
    hub_env.files[f"{REPO}/tiny-q4_k_m.gguf"] = model
    hosts_mod.save_host("local", None, None, fake_llama_command(tmp_path))
    cookbook, events = make_cookbook({"tiny-q4_k_m.gguf": model})
    port = free_port()

    async def main() -> None:
        with pytest.raises(Exception, match="not downloaded"):
            await cookbook.serve_start({"host": "local", "repo_id": REPO, "file": "tiny-q4_k_m.gguf"})
        d = await cookbook.start_download("local", REPO, ["tiny-q4_k_m.gguf"])
        await wait_for(lambda: d.state in ("done", "error"))
        status = await cookbook.serve_start({"host": "local", "repo_id": REPO, "file": "tiny-q4_k_m.gguf",
                                             "port": port, "context": 4096})
        assert status["state"] == "starting" and status["port"] == port and status["context"] == 4096
        await wait_for(lambda: any(e.get("type") == "serve.status" and e["state"] in ("running", "crashed")
                                   for e in events), timeout=60, what="the served model")
        final = [e for e in events if e.get("type") == "serve.status"][-1]
        assert final["state"] == "running", final
        assert final["model"] == f"local-llama-{port}/tiny-gguf-q4_k_m"

        providers = json.loads((harness_home / "providers.json").read_text())
        entry = providers[f"local-llama-{port}"]
        assert entry["base_url"] == f"http://127.0.0.1:{port}/v1" and entry["context_length"] == 4096

        serves = await cookbook.serves("local")
        assert [s["state"] for s in serves["items"]] == ["running"]
        output = await cookbook.serve_output("local", status["name"])
        assert "fake llama-server: model" in output["text"] and "context 4096" in output["text"]

        await cookbook.serve_stop("local", status["name"])
        assert f"local-llama-{port}" not in json.loads((harness_home / "providers.json").read_text())
        assert (await cookbook.serves("local"))["items"] == []
        await wait_for(lambda: not port_open(port), what="the stop")

    asyncio.run(main())


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def test_search_badges_and_fit_filter(harness_home, monkeypatch):
    cookbook = Cookbook()

    async def fake_search(query, library, task, params, sort, page):
        assert (library, task, sort) == ("gguf", "text-generation", "downloads")
        return [{"repo_id": "a/small", "params": 1_000_000_000}, {"repo_id": "b/huge", "params": 400_000_000_000},
                {"repo_id": "c/unknown", "params": None}], True

    async def fake_hardware(host, refresh=False):
        return {"gpus": [{"vram_total": 8 * GB}], "ram_total": 16 * GB}

    cookbook.hub.search = fake_search  # type: ignore[method-assign]
    cookbook.get_hardware = fake_hardware  # type: ignore[method-assign]

    async def main() -> None:
        result = await cookbook.search({"query": "x", "page": 0})
        assert [i["fit"] for i in result["items"]] == ["fits", "no", None] and result["has_more"]
        only = await cookbook.search({"query": "x", "filters": {"fit_only": True}})
        assert [i["repo_id"] for i in only["items"]] == ["a/small"]

    asyncio.run(main())


def test_cookbook_protocol(daemon, harness_home, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "cookbook.hosts"})
    hosts = c.until("cookbook.hosts")[0]
    assert [h["name"] for h in hosts["items"]] == ["local"] and hosts["public_key"] is None
    c.send({"type": "cookbook.host.save", "name": "gpu-box", "ssh": "drew@gpu-box", "python": "python3"})
    hosts = c.until("cookbook.hosts")[0]
    assert hosts["items"][1] == {"name": "gpu-box", "ssh": "drew@gpu-box", "remote": True, "python": "python3",
                                 "llama_server": None, "label": "gpu-box (drew@gpu-box)"}
    c.send({"type": "cookbook.host.save", "name": "x", "ssh": "-oProxyCommand=bad"})
    assert c.until("error")[0]["ref"] == "cookbook.host.save"
    c.send({"type": "cookbook.hardware", "host": "local"})
    hardware = c.until("hardware", timeout=60)[0]
    assert hardware["host"] == "local" and hardware["info"]["cpu_cores"] > 0
    c.send({"type": "hf.token", "token": "hf_test"})
    assert c.until("hf.token")[0]["set"] is True
    c.send({"type": "downloads.list"})
    assert c.until("downloads")[0]["items"] == []
    c.send({"type": "hf.download", "repo_id": "a/b", "files": "not a list"})
    assert "list of file names" in c.until("error")[0]["message"]
    c.send({"type": "hf.token", "token": None})
    c.until("hf.token")
    c.close()
