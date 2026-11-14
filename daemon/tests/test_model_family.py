"""The exact match of the model family, the scaffold tier, the reminder gate, and the prompt ablation."""

from __future__ import annotations

import asyncio

import pytest

from harness_daemon.model_prompts import (
    CLAUDE_COMMENTS, GPT_WORKING_STYLE, model_family, model_guidance, reminder_on, scaffold_tier,
)
from harness_daemon.prompt import BASE_PROMPT, base_prompt

from test_agent import make_agent


@pytest.mark.parametrize("label, family", [
    ("openai/gpt-5.5", "gpt"),
    ("openrouter/openai/gpt-5", "gpt"),
    ("x/gpt-5.1-codex", "gpt"),
    ("x/chatgpt-4o-latest", "gpt"),
    ("x/CodeLlama-13B-GPTQ", None),  # A quantization, not a GPT model.
    ("my-gpt-server/llama3.3:70b", None),  # The provider name does not count.
    ("openrouter/mistralai/codestral-2508", "mistral"),  # The organization segment counts.
    ("local/mistral-large", "mistral"),
    ("x/gemma-3-4b", "gemma"),
    ("google/gemini-3-pro", "gemini"),
    ("anthropic/claude-sonnet-5-5", "claude"),
    ("ollama/qwen2.5-coder:7b", "qwen"),
    ("moonshot/kimi-k2", "kimi"),
    ("openrouter/moonshotai/some-model", "kimi"),
    ("deepseek/deepseek-v4-pro", "deepseek"),
    ("ollama/llama3.3:70b", None),
])
def test_model_family(label, family):
    assert model_family(label) == family


def test_the_override_wins():
    assert model_family("local/my-finetune", "qwen") == "qwen"
    assert model_family("openai/gpt-5.5", "none") is None
    assert model_family("openai/gpt-5.5", "not-a-family") is None
    assert model_guidance("local/my-finetune", family="claude") == [CLAUDE_COMMENTS]


def test_a_quantized_model_gets_no_gpt_block():
    assert GPT_WORKING_STYLE not in model_guidance("x/CodeLlama-13B-GPTQ")


@pytest.mark.parametrize("label, tier", [
    ("x/gemma-3-4b", "small"),
    ("ollama/qwen2.5-coder:7b", "small"),
    ("anthropic/claude-sonnet-5-5", "frontier"),
    ("openai/gpt-5.5", "frontier"),
    ("x/gpt-oss-120b", "standard"),
    ("deepseek/deepseek-v4-pro", "standard"),
    ("ollama/llama3.3:70b", "standard"),
])
def test_scaffold_tier(label, tier):
    assert scaffold_tier(label, model_family(label)) == tier


def test_reminder_on():
    assert reminder_on("plan_start", "frontier", "auto") and reminder_on("plan_start", "small", None)
    assert not reminder_on("plan_start", "small", "off")
    assert reminder_on("plan_stale", "frontier", "on")


def test_no_ablation_gives_the_same_prompt():
    assert base_prompt("anthropic/claude-sonnet-5-5") == BASE_PROMPT
    assert base_prompt("anthropic/claude-sonnet-5-5", ()) == BASE_PROMPT


def test_ablation_leaves_out_parts_and_blocks():
    prompt = base_prompt("anthropic/claude-sonnet-5-5", ("task_list", "tool_calls"))
    assert "Task list (when you have" not in prompt and "Parallel tool calls:" not in prompt
    assert prompt.startswith("You are a coding agent.") and "Finish the task:" in prompt
    assert model_guidance("openai/gpt-5.5", ablate=("gpt_style",))[0] != GPT_WORKING_STYLE


@pytest.mark.parametrize("setting, sent", [("on", True), ("off", False)])
def test_task_reminders_setting(setting, sent, harness_home, project, fake_model):
    call = {"name": "read", "arguments": {"path": "hello.py"}}
    fake_model.script({"tool_calls": [call, call, call]}, {"text": "Done."})
    agent, _, _ = make_agent(project, task_reminders=setting)
    asyncio.run(agent.run_turn("look around"))
    notes = [m for m in fake_model.requests[1]["messages"] if m["role"] == "user" and "you showed no task list" in str(m.get("content"))]
    assert bool(notes) is sent


def test_the_prompt_ablate_setting_reaches_the_system_prompt(harness_home, project):
    agent, _, _ = make_agent(project, prompt_ablate=["finish"])
    assert "Finish the task:" not in agent.system_prompt
