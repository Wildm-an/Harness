"""The network proxy of the sandbox (sandbox_proxy.py) and its wiring in sandbox.py and the bash tool."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

from quick_http import QuickThreadingHTTPServer

from harness_daemon import sandbox, sandbox_proxy
from harness_daemon.config import harness_home
from harness_daemon.sandbox import SandboxPolicy
from harness_daemon.sandbox_proxy import SandboxProxy, domain_allowed, normalize_host
from harness_daemon.tools import BashTool, ToolContext, detect_shell
from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import shell as shell_module
from harness_daemon.tools.bash import BLOCKED_LINE

from test_sandbox import user_settings
from test_server import daemon  # noqa: F401  (a fixture)


# -- the domain rules ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("host, expected", [
    ("Example.COM", "example.com"), ("example.com.", "example.com"), ("[::1]", "::1"), ("127.0.0.1", "127.0.0.1"),
    ("a_b.example.com", "a_b.example.com"), ("", None), ("exa mple.com", None), ("evil.com/x", None),
    ("-bad.com", None), ("a..b", None), (None, None), ("x" * 300, None),
])
def test_normalize_host(host, expected):
    assert normalize_host(host) == expected


@pytest.mark.parametrize("host, port, allowed, denied, expected", [
    ("example.com", 443, ["example.com"], [], True),
    ("EXAMPLE.com.", 443, ["example.com"], [], True),
    ("api.example.com", 443, ["example.com"], [], False),  # An exact pattern does not match a subdomain.
    ("api.example.com", 443, ["*.example.com"], [], True),
    ("a.b.example.com", 80, ["*.example.com"], [], True),
    ("example.com", 443, ["*.example.com"], [], False),  # "*." does not match the domain itself.
    ("badexample.com", 443, ["*.example.com"], [], False),
    ("anything.org", 443, ["*"], [], True),
    ("example.com", 443, [], [], False),  # An empty allow list allows nothing.
    ("bad.example.com", 443, ["*.example.com"], ["bad.example.com"], False),  # Deny wins.
    ("x.example.com", 443, ["*"], ["*.example.com"], False),
    ("example.com", 443, ["example.com:443"], [], True),
    ("example.com", 80, ["example.com:443"], [], False),
    ("example.com", 443, ["example.com:abc"], [], False),
    ("::1", 8080, ["[::1]:8080"], [], True),
    ("127.0.0.1", 5000, ["127.0.0.1"], [], True),
    ("evil.com/x", 443, ["*"], [], False),  # A host that is not valid is never allowed.
    ("example.com", 0, ["example.com"], [], False),
])
def test_domain_allowed(host, port, allowed, denied, expected):
    assert domain_allowed(host, port, allowed, denied) is expected


# -- a real proxy on 127.0.0.1 -------------------------------------------------------------------------------


async def echo_server():
    """A TCP server that sends back each byte. It counts the connections."""
    seen = []

    async def handle(reader, writer):
        seen.append(1)
        while data := await reader.read(1024):
            writer.write(data)
            await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1], seen


async def ask(port: int, request: bytes) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(request)
    await writer.drain()
    head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
    return reader, writer, head


def test_connect_to_an_allowed_host_makes_a_tunnel():
    async def main():
        server, port, seen = await echo_server()
        proxy = SandboxProxy(["127.0.0.1"], [])
        await proxy.start()
        try:
            reader, writer, head = await ask(proxy.port, f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n"
                                                         f"Host: 127.0.0.1:{port}\r\n\r\n".encode())
            assert head.startswith(b"HTTP/1.1 200")
            writer.write(b"ping")
            await writer.drain()
            assert await asyncio.wait_for(reader.readexactly(4), 5) == b"ping"
            writer.close()
            assert proxy.blocked == [] and seen == [1]
        finally:
            await proxy.stop()
            server.close()

    asyncio.run(main())


def test_connect_to_a_blocked_host_gives_403_and_keeps_the_host():
    async def main():
        server, port, seen = await echo_server()
        proxy = SandboxProxy(["*.example.com"], ["bad.example.com"])
        await proxy.start()
        try:
            for target in (f"127.0.0.1:{port}", "bad.example.com:443", "BAD.example.com:443", "evil.org:22"):
                reader, writer, head = await ask(proxy.port, f"CONNECT {target} HTTP/1.1\r\n\r\n".encode())
                assert head.startswith(b"HTTP/1.1 403")
                body = await asyncio.wait_for(reader.read(), 5)
                assert b"Harness sandbox blocked the connection" in body
                writer.close()
            # No connection went to the host. Each blocked host shows one time.
            assert seen == []
            assert proxy.blocked == [f"127.0.0.1:{port}", "bad.example.com:443", "evil.org:22"]
        finally:
            await proxy.stop()
            server.close()

    asyncio.run(main())


def test_plain_http_goes_to_the_host_with_no_proxy_headers():
    async def main():
        got = []

        async def handle(reader, writer):
            got.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            await writer.drain()
            writer.close()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        proxy = SandboxProxy(["127.0.0.1"], [])
        await proxy.start()
        try:
            reader, writer, head = await ask(proxy.port, (
                f"GET http://127.0.0.1:{port}/a/b?q=1 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                "Proxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\n\r\n").encode())
            assert head.startswith(b"HTTP/1.1 200 OK")
            assert await asyncio.wait_for(reader.read(), 5) == b"ok"
            sent = got[0].decode()
            assert sent.startswith("GET /a/b?q=1 HTTP/1.1\r\n") and f"Host: 127.0.0.1:{port}" in sent
            assert "Proxy-" not in sent and "Connection: close" in sent
            writer.close()
        finally:
            await proxy.stop()
            server.close()

    asyncio.run(main())


def test_a_bad_request_gives_400_and_an_empty_connection_closes():
    async def main():
        proxy = SandboxProxy(["*"], [])
        await proxy.start()
        try:
            for request in (b"GET /origin-form HTTP/1.1\r\n\r\n", b"nonsense\r\n\r\n",
                            b"CONNECT example.com HTTP/1.1\r\n\r\n", b"GET https://example.com/ HTTP/1.1\r\n\r\n"):
                _, writer, head = await ask(proxy.port, request)
                assert head.startswith(b"HTTP/1.1 400")
                writer.close()
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy.port)
            writer.close()  # A port check: no request.
            assert proxy.blocked == []
        finally:
            await proxy.stop()

    asyncio.run(main())


def test_a_host_that_does_not_answer_gives_502():
    async def main():
        server = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        server.close()
        await server.wait_closed()  # The port is now closed.
        proxy = SandboxProxy(["127.0.0.1"], [], connect_timeout=5)
        await proxy.start()
        try:
            _, writer, head = await ask(proxy.port, f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
            assert head.startswith(b"HTTP/1.1 502")
            writer.close()
        finally:
            await proxy.stop()

    asyncio.run(main())


def test_stop_closes_an_open_tunnel():
    async def main():
        server, port, _ = await echo_server()
        proxy = SandboxProxy(["127.0.0.1"], [])
        await proxy.start()
        reader, writer, head = await ask(proxy.port, f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
        assert head.startswith(b"HTTP/1.1 200")
        await asyncio.wait_for(proxy.stop(), 5)
        assert await asyncio.wait_for(reader.read(), 5) == b""
        writer.close()
        server.close()

    asyncio.run(main())


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio has no Unix socket server on Windows.")
def test_the_proxy_listens_on_a_unix_socket(tmp_path):
    async def main():
        server, port, _ = await echo_server()
        path = sandbox_proxy.socket_path()
        proxy = SandboxProxy(["127.0.0.1"], [])
        await proxy.start(unix_path=path)
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write(f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
            assert (await reader.readuntil(b"\r\n\r\n")).startswith(b"HTTP/1.1 200")
            writer.close()
        finally:
            await proxy.stop()
            server.close()
        assert not Path(path).exists()

    asyncio.run(main())


def test_the_socket_path_is_short():
    path = sandbox_proxy.socket_path()
    assert len(path) < 100 and path.endswith(".sock") and "," not in path


# -- the policy, the backends, and the status ----------------------------------------------------------------


NETWORK = {"enabled": True, "network": {"allowedDomains": ["example.com"], "deniedDomains": []}}


def test_the_network_mode(monkeypatch):
    config = sandbox.normalize_config(NETWORK)
    assert sandbox.network_mode(sandbox.normalize_config({"enabled": True})) == "off"  # No domain: no network.
    assert sandbox.network_mode(config, platform="darwin") == "proxy"
    assert sandbox.network_mode(config, platform="win32") == "off"
    monkeypatch.setattr(sandbox, "_find_socat", lambda: None)
    assert sandbox.network_mode(config, platform="linux") == "off"
    monkeypatch.setattr(sandbox, "_find_socat", lambda: "/usr/bin/socat")
    assert sandbox.network_mode(config, platform="linux") == "proxy"


def test_the_ready_reason_names_the_network(monkeypatch):
    monkeypatch.setattr(sandbox, "_backend_problem", lambda backend: None)
    config = sandbox.normalize_config(NETWORK)
    assert sandbox.sandbox_status(config, platform="darwin")["reason"] == sandbox.READY_PROXY_REASON
    monkeypatch.setattr(sandbox, "_find_socat", lambda: None)
    assert sandbox.sandbox_status(config, platform="linux")["reason"] == sandbox.NO_SOCAT_REASON
    assert sandbox.sandbox_status({"enabled": True}, platform="darwin")["reason"] == sandbox.READY_REASON


PROXY_POLICY = SandboxPolicy(write_roots=("/home/u/proj",), network="proxy", proxy_port=40123,
                             proxy_socket="/tmp/harness-proxy-ab.sock", temp_dir="/tmp/harness-sandbox/s1")


def test_the_seatbelt_profile_allows_only_the_proxy_port():
    profile = sandbox.seatbelt_profile(PROXY_POLICY)
    assert "(deny network*)" in profile
    assert '(allow network-outbound (remote ip "localhost:40123"))' in profile
    assert "localhost:*" not in profile
    assert profile.index("localhost:40123") > profile.index("(deny network*)")


def test_wrap_on_linux_starts_the_socat_bridge(monkeypatch):
    monkeypatch.setattr(sandbox, "_find_bwrap", lambda: "/usr/bin/bwrap")
    monkeypatch.setattr(sandbox, "_find_socat", lambda: "/usr/bin/socat")
    argv = sandbox.wrap(["/bin/bash", "-c", "curl x"], PROXY_POLICY, platform="linux",
                        exists=lambda p: True, is_dir=lambda p: True)
    cut = argv.index("--")
    assert "--unshare-net" in argv[:cut]  # The command still has no network of its own.
    assert argv[cut + 1:] == ["/bin/sh", "-c", sandbox.LINUX_BRIDGE_SCRIPT, "harness-sandbox", "/usr/bin/socat",
                              "/tmp/harness-proxy-ab.sock", "40123", "/bin/bash", "-c", "curl x"]


def test_wrap_needs_the_proxy_values():
    with pytest.raises(sandbox.SandboxError):
        sandbox.wrap(["sh"], SandboxPolicy(write_roots=(), network="proxy"), platform="darwin")
    with pytest.raises(sandbox.SandboxError):
        sandbox.wrap(["sh"], SandboxPolicy(write_roots=(), network="proxy", proxy_port=1), platform="linux",
                     exists=lambda p: True)


def test_the_proxy_environment():
    env = sandbox.sandbox_env(PROXY_POLICY)
    assert env["HTTPS_PROXY"] == env["http_proxy"] == "http://127.0.0.1:40123"
    assert "127.0.0.1" in env["NO_PROXY"] and env["TMPDIR"] == "/tmp/harness-sandbox/s1"
    assert "HTTPS_PROXY" not in sandbox.sandbox_env(SandboxPolicy(write_roots=(), temp_dir="/t"))


def test_network_for_starts_a_proxy_only_with_allowed_domains():
    base = SandboxPolicy(write_roots=("/p",))

    async def main():
        async with sandbox_proxy.network_for(base, sandbox.normalize_config({"enabled": True}), "darwin") as (p, proxy):
            assert p is base and proxy is None
        async with sandbox_proxy.network_for(None, sandbox.normalize_config(NETWORK), "darwin") as (p, proxy):
            assert p is None and proxy is None
        async with sandbox_proxy.network_for(base, sandbox.normalize_config(NETWORK), "darwin") as (p, proxy):
            assert p.network == "proxy" and p.proxy_port == proxy.port and proxy.allowed == ["example.com"]
            port = proxy.port
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
        with pytest.raises(OSError):  # The proxy stopped with the block.
            await asyncio.open_connection("127.0.0.1", port)

    asyncio.run(main())


def test_set_enabled_keeps_the_other_keys():
    home = harness_home()
    home.mkdir(parents=True, exist_ok=True)
    (home / "settings.json").write_text(json.dumps({"theme": "x", "sandbox": {"network": {"allowedDomains": ["a.b"]}}}),
                                        encoding="utf-8")
    sandbox.set_enabled(True)
    data = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    assert data == {"theme": "x", "sandbox": {"network": {"allowedDomains": ["a.b"]}, "enabled": True}}
    sandbox.set_enabled(False)
    assert sandbox.sandbox_config()["enabled"] is False


# -- the bash tool -------------------------------------------------------------------------------------------


@pytest.fixture
def seatbelt(monkeypatch):
    """A Seatbelt backend that can run. No command runs in a real sandbox."""
    monkeypatch.setattr(sandbox, "_backend_problem", lambda backend: None)
    monkeypatch.setattr(sandbox, "backend_for", lambda platform=None: "seatbelt")


def test_bash_runs_the_proxy_and_names_a_blocked_host(project, monkeypatch, seatbelt):
    user_settings(enabled=True, network={"allowedDomains": ["example.com"]})
    calls = []

    async def fake_run(command, cwd, shell, timeout, env=None, sandbox=None):
        # The command connects through the proxy of its environment, as curl does.
        port = int(env["HTTPS_PROXY"].rsplit(":", 1)[1])
        calls.append((env, sandbox))
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"CONNECT blocked.example.org:443 HTTP/1.1\r\n\r\n")
        head = await reader.readuntil(b"\r\n\r\n")
        writer.close()
        return shell_module.CommandResult(head.decode().splitlines()[0], 56, False)

    monkeypatch.setattr("harness_daemon.tools.bash.run_command", fake_run)
    ctx = ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())
    assert "allowedDomains" in BashTool().describe(ctx)
    result = asyncio.run(BashTool().run({"command": "curl https://blocked.example.org"}, ctx))
    env, policy = calls[0]
    assert policy.network == "proxy" and env["HTTPS_PROXY"] == f"http://127.0.0.1:{policy.proxy_port}"
    assert result.is_error and "403" in result.output
    assert BLOCKED_LINE.format(hosts="blocked.example.org:443") in result.output
    assert "network only to the domains in sandbox.network.allowedDomains" in result.output


def test_bash_has_no_proxy_with_no_allowed_domains(project, monkeypatch, seatbelt):
    user_settings(enabled=True)
    calls = []

    async def fake_run(command, cwd, shell, timeout, env=None, sandbox=None):
        calls.append((env, sandbox))
        return shell_module.CommandResult("out", 0, False)

    monkeypatch.setattr("harness_daemon.tools.bash.run_command", fake_run)
    ctx = ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())
    result = asyncio.run(BashTool().run({"command": "ls"}, ctx))
    env, policy = calls[0]
    assert policy.network == "off" and "HTTPS_PROXY" not in env and result.output == "out"


# -- a real backend (macOS and Linux only) -------------------------------------------------------------------


def _real_proxy_backend() -> bool:
    if sys.platform == "win32" or sandbox.sandbox_status({"enabled": True})["state"] != "ready":
        return False
    config = sandbox.normalize_config(NETWORK)
    return sandbox.network_mode(config) == "proxy" and shell_module.shutil.which("curl") is not None


@pytest.mark.skipif(not _real_proxy_backend(), reason="No sandbox backend with a proxy route on this computer.")
def test_a_real_sandbox_reaches_only_the_allowed_hosts(project):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"hello-from-host")

        def log_message(self, *args):
            pass

    server = QuickThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    user_settings(enabled=True, network={"allowedDomains": ["127.0.0.1"]})
    ctx = ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())
    try:
        # --noproxy '': curl uses the proxy also for 127.0.0.1.
        ok = asyncio.run(BashTool().run({"command": f"curl -sS --noproxy '' --max-time 10 http://127.0.0.1:{port}/"},
                                        ctx))
        assert not ok.is_error and "hello-from-host" in ok.output
        blocked = asyncio.run(BashTool().run({"command": "curl -sS --max-time 10 http://blocked.invalid/"}, ctx))
        assert blocked.is_error and "blocked.invalid:80" in blocked.output
        direct = asyncio.run(BashTool().run({"command": f"curl -sS --noproxy '*' --max-time 5 "
                                                        f"http://127.0.0.1:{port}/"}, ctx))
        assert direct.is_error  # With no proxy, the sandbox has no network.
    finally:
        server.shutdown()


# -- the Settings row (server.py sandbox.set) ----------------------------------------------------------------


def test_sandbox_set_writes_the_user_file_and_sends_the_status(daemon, harness_home, project, fake_model):
    from test_server import Client

    (harness_home / "settings.json").write_text(json.dumps({"sandbox": {"excludedCommands": ["docker *"]}}),
                                                encoding="utf-8")
    c = Client(daemon)
    c.send({"type": "user_settings.get"})
    assert c.until("user_settings")[0]["sandbox"]["state"] == "off"
    c.send({"type": "sandbox.set", "enabled": True})
    status = c.until("user_settings")[0]["sandbox"]
    assert status["state"] in ("ready", "unavailable") and isinstance(status["available"], bool)
    saved = json.loads((harness_home / "settings.json").read_text(encoding="utf-8"))
    assert saved["sandbox"] == {"excludedCommands": ["docker *"], "enabled": True}
    c.send({"type": "sandbox.set", "enabled": "yes"})
    assert "true or false" in c.until("error")[0]["message"]
    c.send({"type": "sandbox.set", "enabled": False})
    assert c.until("user_settings")[0]["sandbox"]["state"] == "off"
    c.close()
