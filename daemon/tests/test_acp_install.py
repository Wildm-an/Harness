"""The downloads of the ACP harnesses (acp_install.py). A local HTTP server gives the registry and the archives."""

from __future__ import annotations

import asyncio
import hashlib
import http.server
import io
import json
import os
import sys
import tarfile
import threading
import zipfile
from pathlib import Path

import pytest

from harness_daemon import acp_harnesses, acp_install
from quick_http import QuickThreadingHTTPServer
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

PROGRAM = "goose.cmd" if os.name == "nt" else "goose"


class Files:
    """The files of the local HTTP server, by path."""

    def __init__(self) -> None:
        self.items: dict[str, bytes] = {}
        self.base = ""


@pytest.fixture
def files(harness_home, monkeypatch):
    store = Files()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = store.items.get(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = QuickThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    store.base = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("HARNESS_ACP_REGISTRY", store.base + "/registry.json")
    yield store
    server.shutdown()


def zip_archive(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def tar_archive(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def publish(files: Files, version: str, archive: bytes, name: str = "goose.zip", sha: str | None = None) -> None:
    """The registry has goose at this version, with this archive for this computer."""
    files.items[f"/{version}/{name}"] = archive
    target = {"archive": f"{files.base}/{version}/{name}", "cmd": f"./goose-package/{PROGRAM}", "args": ["acp"],
              "sha256": sha if sha is not None else hashlib.sha256(archive).hexdigest()}
    files.items["/registry.json"] = json.dumps({"version": "1.0.0", "agents": [
        {"id": "goose", "name": "goose", "version": version, "distribution": {"binary": {acp_install.platform_key(): target}}},
    ]}).encode()


def install(spec):
    stages: list[str] = []

    async def progress(stage: str, received: int, total: int) -> None:
        stages.append(stage)

    data = asyncio.run(acp_install.install(spec, progress))
    return data, stages


def test_versions():
    assert acp_install.is_newer("1.10.0", "1.9.2")
    assert not acp_install.is_newer("1.9.2", "1.10.0")
    assert not acp_install.is_newer("1.0.0", "1.0.0")
    assert not acp_install.is_newer(None, "1.0.0")
    assert acp_install.is_newer("2026.11.05", "2026.10.30")
    assert acp_install._package_version("@google/gemini-cli@0.67.0") == "0.67.0"
    assert acp_install._package_name("@google/gemini-cli@0.67.0") == "@google/gemini-cli"
    assert acp_install._package_name("fast-agent-acp==0.10.1") == "fast-agent-acp"
    assert acp_install.platform_key().split("-")[0] in ("windows", "darwin", "linux")


def test_download_update_and_delete(files, harness_home):
    spec = acp_harnesses.find("goose")
    assert spec is not None
    publish(files, "1.0.0", zip_archive({f"goose-package/{PROGRAM}": b"v1"}))
    data, stages = install(spec)
    assert data["version"] == "1.0.0" and data["kind"] == "binary"
    assert stages[:2] == ["Checking the registry", "Downloading"] and "Unpacking" in stages
    program = harness_home / "harnesses" / "goose" / "1.0.0" / "goose-package" / PROGRAM
    assert program.read_bytes() == b"v1"
    argv, _ = acp_harnesses.launch_argv(spec)
    assert argv == [str(program), "acp"]
    item = acp_harnesses.public(spec)
    assert item["status"] == "downloaded" and item["download"] == {"version": "1.0.0", "kind": "binary"}
    assert item["update"] is False and item["command"] == f"{PROGRAM} acp"

    # A new version in the registry: "Update".
    publish(files, "1.1.0", zip_archive({f"goose-package/{PROGRAM}": b"v2"}))
    assert asyncio.run(acp_install.refresh_registry(force=True)) is True
    item = acp_harnesses.public(spec)
    assert item["update"] is True and item["latest"] == "1.1.0"
    data, _ = install(spec)
    assert data["version"] == "1.1.0"
    assert not (harness_home / "harnesses" / "goose" / "1.0.0").exists()  # The old version goes.
    assert acp_harnesses.public(spec)["update"] is False

    acp_install.remove("goose")
    assert acp_install.installed("goose") is None
    assert acp_harnesses.public(spec)["status"] != "downloaded"
    with pytest.raises(acp_install.InstallError):
        acp_install.remove("goose")


def test_tar_archive(files, harness_home):
    spec = acp_harnesses.find("goose")
    publish(files, "1.0.0", tar_archive({f"goose-package/{PROGRAM}": b"tar"}), name="goose.tar.gz")
    data, _ = install(spec)
    assert Path(data["argv"][0]).read_bytes() == b"tar"


def test_wrong_sha256_stops_the_download(files, harness_home):
    spec = acp_harnesses.find("goose")
    publish(files, "1.0.0", zip_archive({f"goose-package/{PROGRAM}": b"v1"}), sha="0" * 64)
    with pytest.raises(acp_install.InstallError, match="sha256"):
        install(spec)
    assert acp_install.installed("goose") is None
    assert not (harness_home / "harnesses" / "goose" / "1.0.0").exists()


def test_archive_member_out_of_its_folder(files, harness_home):
    spec = acp_harnesses.find("goose")
    publish(files, "1.0.0", zip_archive({"../evil.txt": b"x", f"goose-package/{PROGRAM}": b"v1"}))
    with pytest.raises(acp_install.InstallError, match="out of its folder"):
        install(spec)
    assert not (harness_home / "harnesses" / "evil.txt").exists()
    assert acp_install.installed("goose") is None


def test_no_download_for_this_computer(files, harness_home, monkeypatch):
    monkeypatch.setattr(acp_install.shutil, "which", lambda name: None)
    files.items["/registry.json"] = json.dumps({"agents": [{"id": "goose", "version": "1.0.0", "distribution": {}}]}).encode()
    spec = acp_harnesses.find("goose")
    with pytest.raises(acp_install.InstallError, match="cannot download"):
        install(spec)
    assert acp_harnesses.public(spec)["can_download"] is False
    custom = acp_harnesses.save_custom("Mine", f'"{sys.executable}" agent.py')
    assert acp_install.plan(custom) is None


def test_install_through_the_daemon(daemon, files, harness_home):  # noqa: F811
    publish(files, "1.0.0", zip_archive({f"goose-package/{PROGRAM}": b"v1"}))
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "harnesses.list", "refresh": True})
    listing = c.until("harnesses")[0]
    goose = next(i for i in listing["items"] if i["id"] == "goose")
    assert goose["can_download"] is True and goose["latest"] == "1.0.0" and goose["download"] is None
    c.send({"type": "harnesses.install", "id": "goose"})
    listing, seen = c.until("harnesses", timeout=30)
    assert any(m["type"] == "harnesses.progress" and m["id"] == "goose" for m in seen)
    goose = next(i for i in listing["items"] if i["id"] == "goose")
    assert goose["status"] == "downloaded" and goose["busy"] is None
    c.send({"type": "harnesses.uninstall", "id": "goose"})
    listing = c.until("harnesses")[0]
    assert next(i for i in listing["items"] if i["id"] == "goose")["download"] is None
    c.send({"type": "harnesses.install", "id": "custom-nothing"})
    error = c.until("error")[0]
    assert error["ref"] == "harnesses.install"
    c.close()
