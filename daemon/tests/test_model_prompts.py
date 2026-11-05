from __future__ import annotations

import asyncio

from harness_daemon.model_prompts import (
    CLAUDE_COMMENTS, EXECUTION_DISCIPLINE, GOOGLE_RULES, GPT_WORKING_STYLE, KIMI_RULES, TOOL_USE_ENFORCEMENT,
    is_small_model, model_guidance,
)
from harness_daemon.prompt import base_prompt

from test_agent import make_agent


def test_model_guidance_follows_the_family():
    assert model_guidance("anthropic/claude-opus-5-5") == [CLAUDE_COMMENTS]  # No enforcement for Claude.
    assert model_guidance("openai/gpt-5.5") == [GPT_WORKING_STYLE, TOOL_USE_ENFORCEMENT, EXECUTION_DISCIPLINE]
    assert model_guidance("google/gemini-3-pro") == [TOOL_USE_ENFORCEMENT, GOOGLE_RULES]
    assert model_guidance("deepseek/deepseek-v4-pro") == [TOOL_USE_ENFORCEMENT, EXECUTION_DISCIPLINE]
    assert model_guidance("moonshot/kimi-k2") == [EXECUTION_DISCIPLINE, KIMI_RULES]
    assert model_guidance("local/mistral-large") == [EXECUTION_DISCIPLINE]
    assert model_guidance("ollama/llama3.3:70b") == []
    # The provider name does not count: only the model name.
    assert model_guidance("my-gpt-server/llama3.3:70b") == []
    assert model_guidance("openrouter/openai/gpt-5") == [GPT_WORKING_STYLE, TOOL_USE_ENFORCEMENT, EXECUTION_DISCIPLINE]


def test_execution_discipline_leaves_out_missing_tools():
    [text] = [b for b in model_guidance("x/qwen3-coder", ["read", "grep"]) if b.startswith("# Execution")]
    assert "use bash" not in text and "use read or grep" in text
    [full] = [b for b in model_guidance("x/qwen3-coder", ["bash", "read"]) if b.startswith("# Execution")]
    assert "Git history, branches, and diffs: use bash." in full


def test_small_models_make_one_call_for_each_reply():
    assert is_small_model("ollama/qwen2.5-coder:7b")
    assert is_small_model("local/llama-3.1-8b-instruct")
    assert is_small_model("x/gemma-3-4b")
    assert not is_small_model("x/qwen3-30b-a3b")  # The full size of a mixture of experts counts.
    assert not is_small_model("x/llama3.3:70b")
    assert not is_small_model("anthropic/claude-sonnet-5-5")
    assert "Make one tool call in each reply." in base_prompt("ollama/qwen2.5-coder:7b")
    assert "Parallel tool calls:" not in base_prompt("ollama/qwen2.5-coder:7b")
    assert "Parallel tool calls:" in base_prompt("anthropic/claude-sonnet-5-5")


def test_plan_mode_is_a_note_and_the_system_prompt_stays(harness_home, project, fake_model):
    fake_model.script({"text": "A plan."}, {"text": "Done."}, {"text": "Ok."})
    agent, _, _ = make_agent(project, permission_mode="plan")
    prompt = agent.system_prompt
    asyncio.run(agent.run_turn("plan it"))
    sent = fake_model.requests[0]["messages"]
    assert sent[0]["content"] == prompt and "Plan mode is on" not in prompt
    assert sent[-1]["role"] == "user" and sent[-1]["content"].startswith("plan it\n\n[Harness: Plan mode is on.")
    # The user turns plan mode off: the next turn says so, one time.
    agent.reload_settings({**agent.settings, "permission_mode": "default"})
    assert agent.system_prompt == prompt
    asyncio.run(agent.run_turn("do it"))
    assert fake_model.requests[1]["messages"][-1]["content"].startswith("do it\n\n[Harness: Plan mode is off.")
    asyncio.run(agent.run_turn("more"))
    assert fake_model.requests[2]["messages"][-1]["content"] == "more"
    assert fake_model.requests[2]["messages"][0]["content"] == prompt


def test_a_memory_change_is_a_note(harness_home, project, fake_model):
    fake_model.script({"text": "Ok."})
    agent, _, _ = make_agent(project)
    prompt = agent.system_prompt
    agent.memory.save("python", "The user writes Python.", "user", "The user writes Python.")
    agent.memory_changed()
    assert agent.system_prompt == prompt  # The snapshot stays until the next compaction.
    asyncio.run(agent.run_turn("hi"))
    last = fake_model.requests[0]["messages"][-1]["content"]
    assert last.startswith("hi\n\n[Harness: The user changed the memory in Settings.")
    assert "The user writes Python." in last
