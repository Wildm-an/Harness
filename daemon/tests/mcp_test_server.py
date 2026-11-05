"""A small MCP server for the MCP tests.

    python mcp_test_server.py                  # stdio
    python mcp_test_server.py http <port>      # streamable HTTP at http://127.0.0.1:<port>/mcp

Tools: add, echo, fail (an error result), picture (an image), secret (reads the env
variable MCP_TEST_SECRET), and add_tool (adds a tool and sends tools/list_changed).
"""

from __future__ import annotations

import base64
import os
import sys

from mcp.server.mcpserver import Context, MCPServer

server = MCPServer("harness-test")

# A 1x1 PNG.
PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


@server.tool(description="Add two integers.")
def add(a: int, b: int) -> int:
    return a + b


@server.tool(description="Return the text.")
def echo(text: str) -> str:
    return text


@server.tool(description="Always fails.")
def fail() -> str:
    raise ValueError("this tool always fails")


@server.tool(description="Return a small image.")
def picture():
    from mcp.server.mcpserver import Image

    return Image(data=PIXEL, format="png")


@server.tool(description="Return the value of MCP_TEST_SECRET.")
def secret() -> str:
    return os.environ.get("MCP_TEST_SECRET", "(not set)")


@server.tool(description="Add the tool 'late', then tell the client that the tool list changed.")
async def add_tool(ctx: Context) -> str:
    def late() -> str:
        return "late tool"

    server.add_tool(late, name="late", description="A tool that comes later.")
    await ctx.session.send_tool_list_changed()
    return "added"


def oauth_app(port: int):
    """The HTTP server with a small OAuth authorization server in front of it, for the OAuth tests.

    It has protected resource metadata, authorization server metadata, dynamic client registration,
    an /authorize page that sends the browser to the redirect URI at once, and a /token endpoint with
    PKCE. As GitHub, /token sends a form-encoded body unless the request asks for JSON. The client
    "fixed-client" is registered from the start. /debug gives the parameters of the last /authorize.
    The token "static-token" works from the start, and /user gives its account, as the GitHub API.
    As Google, /userinfo gives the address of a token (/set-email changes it), and /revoke records a token.
    """
    import hashlib
    import json
    import secrets
    from urllib.parse import parse_qs, urlencode

    inner = server.streamable_http_app()
    base = f"http://127.0.0.1:{port}"
    data: dict = {"clients": {"fixed-client": {}}, "codes": {}, "tokens": {"static-token"}, "refresh": set(),
                  "authorize": {}, "email": "pat@gmail.com", "revoked": []}

    async def body_of(receive) -> bytes:
        chunks = []
        while True:
            message = await receive()
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                return b"".join(chunks)

    async def reply(send, status: int, body: bytes = b"", kind: str = "application/json", extra=()) -> None:
        headers = [(b"content-type", kind.encode()), (b"content-length", str(len(body)).encode()), *extra]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    def as_json(value) -> bytes:
        return json.dumps(value).encode()

    async def app(scope, receive, send):
        if scope["type"] != "http":
            return await inner(scope, receive, send)
        path = scope["path"]
        query = {k: v[0] for k, v in parse_qs(scope["query_string"].decode()).items()}
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        if path.startswith("/.well-known/oauth-protected-resource"):
            return await reply(send, 200, as_json({"resource": f"{base}/mcp", "authorization_servers": [base],
                                                   "scopes_supported": ["read", "write"]}))
        if path.startswith("/.well-known/oauth-authorization-server"):
            return await reply(send, 200, as_json({
                "issuer": base, "authorization_endpoint": f"{base}/authorize", "token_endpoint": f"{base}/token",
                "registration_endpoint": f"{base}/register", "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"]}))
        if path == "/register":
            request = json.loads(await body_of(receive))
            client_id = "dyn-" + secrets.token_hex(6)
            data["clients"][client_id] = request
            return await reply(send, 201, as_json({**request, "client_id": client_id}))
        if path == "/authorize":
            data["authorize"] = query
            if query.get("client_id") not in data["clients"]:
                return await reply(send, 400, b"unknown client", "text/plain")
            code = secrets.token_hex(8)
            data["codes"][code] = query
            location = query["redirect_uri"] + "?" + urlencode({"code": code, "state": query.get("state", "")})
            return await reply(send, 302, b"", "text/plain", [(b"location", location.encode())])
        if path == "/token":
            form = {k: v[0] for k, v in parse_qs((await body_of(receive)).decode()).items()}
            if form.get("grant_type") == "authorization_code":
                start = data["codes"].pop(form.get("code", ""), None)
                verifier = form.get("code_verifier", "")
                import base64
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
                if start is None or start.get("code_challenge") != challenge or start["redirect_uri"] != form.get("redirect_uri"):
                    return await reply(send, 400, as_json({"error": "invalid_grant"}))
            elif form.get("grant_type") == "refresh_token":
                if form.get("refresh_token") not in data["refresh"]:
                    return await reply(send, 400, as_json({"error": "invalid_grant"}))
            else:
                return await reply(send, 400, as_json({"error": "unsupported_grant_type"}))
            token, refresh = secrets.token_hex(12), secrets.token_hex(12)
            data["tokens"].add(token)
            data["refresh"].add(refresh)
            grant = {"access_token": token, "token_type": "bearer", "expires_in": 3600, "refresh_token": refresh}
            if "application/json" in headers.get("accept", ""):
                return await reply(send, 200, as_json(grant))
            return await reply(send, 200, urlencode(grant).encode(), "application/x-www-form-urlencoded")
        if path == "/user":  # As the GitHub API: the account of the token.
            token = headers.get("authorization", "")[len("Bearer "):]
            if token not in data["tokens"]:
                return await reply(send, 401, as_json({"message": "Bad credentials"}))
            return await reply(send, 200, as_json({"login": "octo"}))
        if path == "/userinfo":  # As Google: the address of the account of the token.
            token = headers.get("authorization", "")[len("Bearer "):]
            if token not in data["tokens"]:
                return await reply(send, 401, as_json({"error": "invalid_token"}))
            return await reply(send, 200, as_json({"email": data["email"], "email_verified": True}))
        if path == "/set-email":  # The account of the next sign-in.
            data["email"] = query.get("email", data["email"])
            return await reply(send, 200, b"{}")
        if path == "/revoke":
            form = {k: v[0] for k, v in parse_qs((await body_of(receive)).decode()).items()}
            data["revoked"].append(form.get("token"))
            return await reply(send, 200, b"{}")
        if path == "/revoked":
            return await reply(send, 200, as_json(data["revoked"]))
        if path == "/debug":
            return await reply(send, 200, as_json(data["authorize"]))
        if path.startswith("/mcp"):
            token = headers.get("authorization", "")[len("Bearer "):]
            if token not in data["tokens"]:
                challenge = f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"'
                return await reply(send, 401, as_json({"error": "invalid_token"}), extra=[
                    (b"www-authenticate", challenge.encode())])
        return await inner(scope, receive, send)

    return app


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] in ("http", "oauth"):
        import uvicorn

        port = int(sys.argv[2])
        app = oauth_app(port) if sys.argv[1] == "oauth" else server.streamable_http_app()
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    else:
        server.run("stdio")


if __name__ == "__main__":
    main()
