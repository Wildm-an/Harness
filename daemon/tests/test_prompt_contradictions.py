"""The prompt blocks do not contradict each other (change 7b). Each test names the old text that it keeps out."""

from __future__ import annotations

from types import SimpleNamespace

from harness_daemon import model_prompts, prompt
from harness_daemon.tools.tasks import AgentTool

ALL_TOOLS = ("read", "grep", "bash")


def small_qwen_prompt() -> str:
    """A small Qwen model gets the small tool call rules and the execution discipline block."""
    model = "ollama/qwen2.5-coder:7b"
    assert model_prompts.is_small_model(model)
    return "\n\n".join([prompt.base_prompt(model), *model_prompts.model_guidance(model, ALL_TOOLS)])


def test_small_model_asks_only_before_a_change():
    # Contradiction 1: "ask the user before you read files" against <act_dont_ask>.
    text = small_qwen_prompt()
    assert "<act_dont_ask>" in text
    assert "before you read files" not in text
    assert "ask the user which one before you change files" in text


def test_small_model_tries_one_other_query():
    # Contradiction 2: "Do not search again in a loop" against "try a broader or different query".
    text = small_qwen_prompt()
    assert "Do not search again in a loop." in text
    assert "broader" not in text
    assert "try one different query before you decide" in text


def test_the_date_comes_from_the_environment_section():
    # Contradiction 3: "The current time and date: use bash" against the Date line of the Environment section.
    text = small_qwen_prompt()
    assert "time and date" not in text
    assert "The current time: use bash. The Environment section gives the date." in text
    assert "<facts_from_tools>" in text and "mandatory_tool_use" not in text


def test_a_tool_error_states_the_fix():
    # Contradiction 4: "Then try a different approach" against tool errors that state the fix.
    assert "try a different approach" not in prompt.BASE_RULES
    assert "It often states the fix." in prompt.BASE_RULES


def test_small_sums_do_not_need_bash():
    # Contradiction 6: "Arithmetic and calculations: use bash" gave a permission question for each small sum.
    text = model_prompts.execution_discipline(ALL_TOOLS)
    assert "Arithmetic" not in text
    assert "Calculations with large numbers or many steps: use bash." in text


def test_a_write_does_not_need_a_question():
    # Contradiction 7: "confirm its scope" made the model ask before each write.
    text = model_prompts.execution_discipline(ALL_TOOLS)
    assert "confirm its scope" not in text
    assert "stays in the scope of the request" in text


def test_the_tool_lines_match_the_block():
    # A line of TOOL_LINES that is not in the block is never removed, and the bash lines stay without bash.
    for line in model_prompts.TOOL_LINES:
        assert line in model_prompts.EXECUTION_DISCIPLINE
    assert "use bash" not in model_prompts.execution_discipline(("read", "grep"))


def test_the_agent_tool_states_its_cost(tmp_path):
    # The description uses only the project folder of the context, to find the agent types.
    text = AgentTool(run=None).describe(SimpleNamespace(cwd=tmp_path))  # type: ignore[arg-type]
    assert "Cost: a subagent does not see this conversation." in text
    assert "Do not use it for a task of a few tool calls" in text
