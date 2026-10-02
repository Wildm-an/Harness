"""The models of Ollama and LM Studio in the Cookbook: the Installed list and the delete commands."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

from harness_daemon.cookbook import hostscript
from harness_daemon.cookbook.hosts import HostError
from harness_daemon.cookbook.service import Cookbook
from quick_http import QuickThreadingHTTPServer


class FakeOllama:
    """GET /api/tags and DELETE /api/delete, as an Ollama server answers them."""

    def __init__(self) -> None:
        self.models = {
            "qwen2.5-coder:7b": {"size": 4_700_000_000, "details": {"parameter_size": "7.6B", "quantization_level": "Q4_K_M"}},
            "llama3.2:3b": {"size": 2_000_000_000, "details": {"parameter_size": "3.2B", "quantization_level": "Q4_K_M"}},
        }
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self, code: int, body: dict | None = None) -> None:
                data = json.dumps(body or {}).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802
                if self.path != "/api/tags":
                    return self.reply(404)
                self.reply(200, {"models": [{"name": n, "model": n, "modified_at": "2026-09-01T00:00:00Z", **m}
                                            for n, m in fake.models.items()]})

            def do_DELETE(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                name = body.get("model") or body.get("name")
                if self.path != "/api/delete" or name not in fake.models:
                    return self.reply(404, {"error": "model not found"})
                del fake.models[name]
                self.reply(200)

            def log_message(self, *args) -> None:
                pass

        self.server = QuickThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.server.shutdown()


@pytest.fixture
def home(harness_home, tmp_path, monkeypatch) -> Path:
    """A home folder for the host script (LM Studio looks in it), and an empty Hugging Face cache."""
    folder = tmp_path / "home"
    folder.mkdir()
    for name in ("HOME", "USERPROFILE"):
        monkeypatch.setenv(name, str(folder))
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hf-cache"))
    return folder


@pytest.fixture
def ollama(monkeypatch):
    fake = FakeOllama()
    monkeypatch.setenv("OLLAMA_HOST", f"127.0.0.1:{fake.port}")
    yield fake
    fake.stop()


def lmstudio_model(root: Path, model_id: str, files: dict[str, int]) -> Path:
    folder = root.joinpath(*model_id.split("/"))
    folder.mkdir(parents=True)
    for name, size in files.items():
        (folder / name).write_bytes(b"\0" * size)
    return folder


def closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_the_ollama_url(monkeypatch):
    for value, url in [(None, "http://127.0.0.1:11434"), ("0.0.0.0", "http://127.0.0.1:11434"),
                       ("box:8000", "http://box:8000"), ("https://gpu.example/", "https://gpu.example:11434")]:
        if value is None:
            monkeypatch.delenv("OLLAMA_HOST", raising=False)
        else:
            monkeypatch.setenv("OLLAMA_HOST", value)
        assert hostscript.ollama_url() == url


def test_installed_lists_and_deletes_ollama_models(home, ollama):
    cookbook = Cookbook()

    async def main() -> None:
        found = (await cookbook.installed("local"))["ollama"]
        assert found["running"] and [m["name"] for m in found["models"]] == ["llama3.2:3b", "qwen2.5-coder:7b"]
        assert found["models"][1]["parameters"] == "7.6B" and found["models"][1]["size"] == 4_700_000_000

        await cookbook.delete_other("local", "ollama", "llama3.2:3b")
        assert list(ollama.models) == ["qwen2.5-coder:7b"]
        with pytest.raises(HostError, match="Ollama has no model"):
            await cookbook.delete_other("local", "ollama", "missing:1b")

    asyncio.run(main())


def test_ollama_that_does_not_run(home, monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", f"127.0.0.1:{closed_port()}")
    found = asyncio.run(Cookbook().installed("local"))["ollama"]
    assert found["running"] is False and found["models"] == []


def test_installed_lists_and_deletes_lmstudio_models(home):
    root = home / ".lmstudio" / "models"
    lmstudio_model(root, "lmstudio-community/Qwen2.5-7B-GGUF", {"qwen-q4.gguf": 300, "mmproj.gguf": 100, "README.md": 10})
    lmstudio_model(root, "bartowski/Tiny-GGUF", {"tiny.gguf": 50})
    cookbook = Cookbook()

    async def main() -> None:
        found = (await cookbook.installed("local"))["lmstudio"]
        assert Path(found["folder"]) == root
        assert [m["id"] for m in found["models"]] == ["bartowski/Tiny-GGUF", "lmstudio-community/Qwen2.5-7B-GGUF"]
        qwen = found["models"][1]
        assert [f["name"] for f in qwen["files"]] == ["mmproj.gguf", "qwen-q4.gguf"] and qwen["size"] == 400

        await cookbook.delete_other("local", "lmstudio", "bartowski/Tiny-GGUF")
        # The empty publisher folder goes too.
        assert not (root / "bartowski").exists() and (root / "lmstudio-community").is_dir()

    asyncio.run(main())


def test_lmstudio_folder_from_its_settings(home, tmp_path):
    custom = tmp_path / "big-disk" / "models"
    lmstudio_model(custom, "pub/model", {"m.gguf": 10})
    (home / ".lmstudio").mkdir()
    (home / ".lmstudio" / "settings.json").write_text(json.dumps({"downloadsFolder": str(custom)}))
    found = asyncio.run(Cookbook().installed("local"))["lmstudio"]
    assert Path(found["folder"]) == custom and [m["id"] for m in found["models"]] == ["pub/model"]


def test_lmstudio_delete_stays_in_the_models_folder(home, tmp_path):
    root = home / ".lmstudio" / "models"
    lmstudio_model(root, "pub/model", {"m.gguf": 10})
    outside = tmp_path / "keep"
    outside.mkdir()
    cookbook = Cookbook()

    async def main() -> None:
        for bad in ("../keep", "pub/../../keep", "pub", "pub/model/extra", "pub/missing"):
            with pytest.raises(HostError):
                await cookbook.delete_other("local", "lmstudio", bad)

    asyncio.run(main())
    assert outside.is_dir() and (root / "pub" / "model" / "m.gguf").is_file()


def test_no_lmstudio_folder(home):
    assert asyncio.run(Cookbook().installed("local"))["lmstudio"] == {"folder": None, "models": []}


def test_an_unknown_source_fails(home):
    with pytest.raises(Exception, match="Unknown model source"):
        asyncio.run(Cookbook().delete_other("local", "other", "x"))
