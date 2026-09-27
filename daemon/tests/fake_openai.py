"""A fake OpenAI-compatible model server for tests.

Each request takes the next scripted reply. A reply is a dict:
``{"text": "...", "tool_calls": [{"name": "read", "arguments": {...}}]}``.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse


class FakeModel:
    def __init__(self, capabilities: list[str] | None = None):
        self.replies: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self.capabilities = capabilities if capabilities is not None else ["completion", "tools"]
        self.num_ctx: int | None = 32768  # Reported by /api/show. None: not set.
        self.required_key: str | None = None  # If set, /v1/models needs "Authorization: Bearer <key>".
        self.models = ["test-model", "other-model"]
        self.app = self._build_app()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self.port = 0

    def script(self, *replies: dict[str, Any]) -> None:
        self.replies.extend(replies)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def _build_app(self) -> FastAPI:
        app = FastAPI()

        @app.post("/api/show")
        async def show(request: Request):
            body = {"capabilities": self.capabilities, "model_info": {"llama.context_length": 131072}}
            if self.num_ctx:
                body["parameters"] = f"num_ctx                        {self.num_ctx}"
            return body

        @app.get("/v1/models")
        async def models(request: Request):
            if self.required_key and request.headers.get("authorization") != f"Bearer {self.required_key}":
                return JSONResponse({"error": {"message": "Incorrect API key."}}, status_code=401)
            return {"object": "list", "data": [{"id": m, "object": "model"} for m in self.models]}

        @app.post("/v1/chat/completions")
        async def completions(request: Request):
            body = await request.json()
            self.requests.append(body)
            if not self.replies:
                return JSONResponse({"error": {"message": "No scripted reply."}}, status_code=500)
            reply = self.replies.pop(0)
            return StreamingResponse(_sse(reply), media_type="text/event-stream")

        return app

    def start(self) -> "FakeModel":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        self.port = sock.getsockname()[1]
        config = uvicorn.Config(self.app, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, kwargs={"sockets": [sock]}, daemon=True)
        self._thread.start()
        deadline = time.time() + 10
        while not self._server.started and time.time() < deadline:
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._thread:
            self._thread.join(timeout=10)


def _chunk(delta: dict[str, Any], finish: str | None = None) -> str:
    body = {
        "id": "chatcmpl-fake",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "fake",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(body)}\n\n"


async def _sse(reply: dict[str, Any]):
    yield _chunk({"role": "assistant", "content": ""})
    text = reply.get("text") or ""
    for i in range(0, len(text), 5):
        yield _chunk({"content": text[i:i + 5]})
    calls = reply.get("tool_calls") or []
    for index, call in enumerate(calls):
        args = call.get("arguments", {})
        raw = args if isinstance(args, str) else json.dumps(args)
        yield _chunk({"tool_calls": [{
            "index": index,
            "id": call.get("id", f"call_{index}_{call['name']}"),
            "type": "function",
            "function": {"name": call["name"], "arguments": ""},
        }]})
        for i in range(0, len(raw), 7):
            yield _chunk({"tool_calls": [{"index": index, "function": {"arguments": raw[i:i + 7]}}]})
    yield _chunk({}, "tool_calls" if calls else "stop")
    prompt_tokens = reply.get("prompt_tokens", 100)
    usage = {"prompt_tokens": prompt_tokens, "completion_tokens": 10, "total_tokens": prompt_tokens + 10}
    yield "data: " + json.dumps({"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 0,
                                 "model": "fake", "choices": [], "usage": usage}) + "\n\n"
    yield "data: [DONE]\n\n"
