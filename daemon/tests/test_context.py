"""Tests for context length resolution and compaction."""

from __future__ import annotations

import asyncio
import json

from harness_daemon.agent import Agent
from harness_daemon.config import load_settings
from harness_daemon.context import SUMMARY_PROMPT, TRIMMED, split_turns
from harness_daemon.providers import ModelClient, OLLAMA_DEFAULT_CONTEXT, resolve_context_length, resolve_model

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def ctx_len(model="fake/m", settings=None):
    provider, name = resolve_model(model)
    return asyncio.run(resolve_context_length(provider, name, settings or {}))


def test_context_length_from_ollama_num_ctx(harness_home, fake_model):
    info = ctx_len()
    assert (info.length, info.source, info.warning) == (32768, "Ollama num_ctx", None)


def test_ollama_default_context_has_a_warning(harness_home, fake_model):
    fake_model.num_ctx = None
    info = ctx_len()
    assert info.length == OLLAMA_DEFAULT_CONTEXT and "OLLAMA_CONTEXT_LENGTH" in info.warning


def test_context_length_from_settings_and_providers(harness_home, fake_model):
    assert ctx_len(settings={"context_length": 1234}).length == 1234
    data = json.loads((harness_home / "providers.json").read_text())
    data["fake"]["models"] = {"m": {"context_length": 65536}}
    (harness_home / "providers.json").write_text(json.dumps(data))
    info = ctx_len()
    assert (info.length, info.source) == (65536, "providers.json")


def test_unknown_context_length_uses_the_default(harness_home, fake_model):
    data = json.loads((harness_home / "providers.json").read_text())
    data["fake"]["kind"] = "openai"  # No /props and no model list on the fake server.
    (harness_home / "providers.json").write_text(json.dumps(data))
    info = ctx_len()
    assert info.source == "default" and "unknown" in info.warning


def make_agent(project, history):
    events: list[dict] = []
    compactions: list[tuple[int, str | None]] = []

    async def emit(event):
        events.append(event)

    async def approver(request):
        return "allow_once"

    provider, model = resolve_model("fake/m")
    agent = Agent(cwd=project, client=ModelClient(provider, model), emit=emit, approver=approver,
                  settings=load_settings(project), history=history,
                  on_compact=lambda removed, summary: compactions.append((removed, summary)))
    return agent, events, compactions


def old_turns(count, size=800):
    history = []
    for i in range(count):
        history.append({"role": "user", "content": f"Question {i}: " + "x" * size})
        history.append({"role": "assistant", "content": f"Answer {i}."})
    return history


def test_auto_compaction_keeps_the_last_four_turns(harness_home, project, fake_model):
    agent, events, compactions = make_agent(project, old_turns(6))
    # Put the limit just below the size of the next request, so that the agent must compact.
    agent.context_length = int(agent.context_tokens() / 0.8)
    fake_model.script({"text": "The user asked six questions."}, {"text": "Done."})

    assert asyncio.run(agent.run_turn("Question 6")) == "end"

    summary_request, turn_request = fake_model.requests
    assert summary_request["messages"][0]["content"] == SUMMARY_PROMPT
    assert "tools" not in summary_request
    assert "USER: Question 0" in summary_request["messages"][1]["content"]
    assert "The user asked six questions." in turn_request["messages"][0]["content"]
    users = [m["content"][:10] for m in turn_request["messages"] if m["role"] == "user"]
    assert users == ["Question 3", "Question 4", "Question 5", "Question 6"]

    event = next(e for e in events if e["type"] == "context.compacted")
    assert event["reason"] == "auto" and event["removed_messages"] == 6
    assert compactions == [(6, "The user asked six questions.")]
    end = events[-1]
    assert end["type"] == "turn.end" and end["usage"]["context_length"] == agent.context_length


def test_a_compaction_in_a_turn_moves_the_turn_start(harness_home, project, fake_model):
    agent, _, _ = make_agent(project, old_turns(6))
    agent.context_length = int(agent.context_tokens() / 0.8)
    fake_model.script({"text": "The user asked six questions."}, {"text": "Done."})
    asyncio.run(agent.run_turn("Question 6"))
    # The plan reminders read the calls of the turn from _turn_start. It must be the user message of this turn.
    assert agent.history[agent._turn_start]["content"] == "Question 6"


def test_clear_drops_the_queued_harness_notes(harness_home, project, fake_model):
    agent, _, _ = make_agent(project, old_turns(1))
    agent._harness_notes.append("[Harness: an old note]")
    agent.clear()
    assert agent._harness_notes == [] and agent.history == []


def test_the_fake_model_scripts_the_finish_reason_and_the_usage(harness_home, fake_model):
    provider, model = resolve_model("fake/m")
    client = ModelClient(provider, model)

    async def ignore(_text):
        return None

    fake_model.script({"text": "cut", "finish": "length", "cached_tokens": 64, "completion_tokens": 7},
                      {"text": "no usage", "finish": None, "no_usage": True})
    first = asyncio.run(client.stream([{"role": "user", "content": "a"}], [], ignore))
    second = asyncio.run(client.stream([{"role": "user", "content": "b"}], [], ignore))
    assert first.finish_reason == "length" and first.usage["completion_tokens"] == 7
    assert first.usage["prompt_tokens_details"]["cached_tokens"] == 64
    assert second.finish_reason is None and second.usage is None


def test_large_tool_outputs_are_trimmed_when_a_summary_cannot_help(harness_home, project, fake_model):
    history = [
        {"role": "user", "content": "read it"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "read", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "y" * 20000, "is_error": False},
        {"role": "assistant", "content": "It is long."},
    ]
    agent, events, compactions = make_agent(project, history)
    agent.context_length = int(agent.context_tokens() / 0.8)
    fake_model.script({"text": "ok"})
    asyncio.run(agent.run_turn("next"))
    event = next(e for e in events if e["type"] == "context.compacted")
    assert event["trimmed_outputs"] == 1 and event["removed_messages"] == 0 and compactions == []
    tool_message = next(m for m in fake_model.requests[0]["messages"] if m["role"] == "tool")
    assert tool_message["content"] == TRIMMED


def test_split_turns():
    turns = split_turns(old_turns(2) + [{"role": "user", "content": "q"}])
    assert [len(t) for t in turns] == [2, 2, 1]


def test_compact_command_and_resume(daemon, project, fake_model):  # noqa: F811
    (project / "HARNESS.md").write_text("Always answer in one line.")
    fake_model.script({"text": "one"}, {"text": "two"}, {"text": "three"}, {"text": "Summary of one and two."})
    c = Client(daemon)
    ready = c.new_session(project)
    assert ready["instructions"] == "HARNESS.md" and ready["summary"] is None
    # The checks of the endpoint run after the open and give the context length.
    info = c.until("session.model_info")[0]
    assert info["context_length"] == 32768 and info["context_source"] == "Ollama num_ctx"
    for text in ("first", "second", "third"):
        c.send({"type": "prompt", "text": text})
        c.until("turn.end")
    assert "Always answer in one line." in fake_model.requests[0]["messages"][0]["content"]

    c.send({"type": "command", "name": "compact", "args": ""})
    compacted, _ = c.until("context.compacted")
    assert compacted["reason"] == "manual" and compacted["summary"] == "Summary of one and two."
    end = c.until("turn.end")[0]
    assert end["stop_reason"] == "end"

    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    resumed = c.until("session.ready")[0]
    assert resumed["summary"] == "Summary of one and two."
    assert [m["content"] for m in resumed["history"] if m["role"] == "user"] == ["second", "third"]
    c.close()


def test_compact_with_too_little_history(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "command", "name": "compact", "args": ""})
    result, _ = c.until("command.result")
    assert "not enough history" in result["text"]
    assert c.until("turn.end")[0]["stop_reason"] == "end"
    c.close()


def test_context_breakdown(daemon, project, harness_home, fake_model):  # noqa: F811
    (project / "HARNESS.md").write_text("Use tabs. " * 200)
    c = Client(daemon)
    c.new_session(project)
    fake_model.script({"text": "Done."})
    # The endpoint counts 100 tokens, and the parts are scaled to it: the message must be long enough to keep a share.
    c.send({"type": "prompt", "text": "Say hello " * 200})
    c.until("turn.end")
    c.send({"type": "context.get"})
    usage = c.until("context.usage")[0]
    parts = {p["kind"]: p["tokens"] for p in usage["parts"]}
    assert list(parts) == ["system", "instructions", "skills", "plugins", "summary", "tools", "mcp_tools", "messages"]
    assert parts["instructions"] > 0 and parts["tools"] > 0 and parts["messages"] > 0
    assert parts["instructions"] > parts["skills"]  # The project instructions are long.
    assert parts["summary"] == 0 and parts["mcp_tools"] == 0 and parts["plugins"] == 0
    assert sum(parts.values()) == usage["tokens"] and usage["length"] == 32768 and usage["compact_at"] == 0.8
    c.close()


def test_context_breakdown_counts_tool_results_as_messages(daemon, project, harness_home, fake_model):  # noqa: F811
    (project / "notes.txt").write_text("A long line of notes. " * 300)
    c = Client(daemon)
    c.new_session(project)
    # A real endpoint count: the default of 100 tokens scales the small parts down to 0.
    fake_model.script({"tool_calls": [{"name": "read", "arguments": {"path": "notes.txt"}}]},
                      {"text": "Read it.", "prompt_tokens": 8000})
    c.send({"type": "prompt", "text": "Read the notes."})
    c.until("turn.end")
    c.send({"type": "context.get"})
    usage = c.until("context.usage")[0]
    parts = {p["kind"]: p["tokens"] for p in usage["parts"]}
    assert "tool_results" not in parts
    # The prompt and the answer are less than 20 tokens. The rest of the messages is the file text, a tool result.
    assert parts["messages"] > 200
    assert sum(parts.values()) == usage["tokens"]
    c.close()
