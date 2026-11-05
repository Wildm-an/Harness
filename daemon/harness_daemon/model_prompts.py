"""Prompt text for each model family, after the base prompt.

The families and the text follow two other agent harnesses:
- Hermes Agent (NousResearch/hermes-agent, agent/prompt_builder.py): the tool use enforcement and the
  execution discipline blocks, with the same model lists. Claude gets neither block, because Claude does
  not show these faults. Lines that name a tool that the agent does not have are left out.
- opencode (anomalyco/opencode, packages/core/src/plugin/system-prompt): the GPT working style, the
  Gemini rules, the Kimi rules, the Claude code comment note, and one tool call for each reply for
  small models.

The text is rewritten in the style of the base prompt. See docs/research/TOOL_USE_AND_PROMPTS.md.
"""

from __future__ import annotations

import re
from collections.abc import Collection

# The model name substrings of each block (the lists of Hermes Agent).
TOOL_USE_MODELS = ("gpt", "codex", "gemini", "gemma", "grok", "glm", "qwen", "deepseek")
EXECUTION_MODELS = ("gpt", "codex", "grok", "deepseek", "kimi", "qwen", "glm", "minimax", "mimo", "mistral")
GOOGLE_MODELS = ("gemini", "gemma")
KIMI_MODELS = ("kimi", "moonshot")
SMALL_MODEL_BILLIONS = 14  # A model with at most this many billion parameters gets one tool call for each reply.

PARALLEL_TOOL_CALLS = """\
Parallel tool calls:
- When tool calls do not depend on each other, make them all in one reply. \
For example, read three files with three read calls in one reply.
- Make the calls one at a time only when a call needs the result of an earlier call."""

# opencode trinity.txt: a small model makes better calls one at a time.
SMALL_MODEL_TOOL_CALLS = """\
Tool calls:
- Make one tool call in each reply. Wait for its result before you make the next call.
- When a result is useful, use it for the next step. Do not search again in a loop.
- If the request is not clear, ask the user before you read files or make changes."""

# Hermes Agent TOOL_USE_ENFORCEMENT_GUIDANCE.
TOOL_USE_ENFORCEMENT = """\
# Tool use
- Use your tools to do the work. Do not only describe what you would do or what you plan to do.
- When you write that you will do an action (for example "I will run the tests" or "Let me check \
the file"), make the tool call for it in the same reply.
- Do not end your turn with a promise of a later action. Do the action now.
- Continue until the task is complete. Do not stop with a summary of what you plan to do next.
- Each reply either makes tool calls that move the task forward, or gives the final result to the user."""

# Hermes Agent OPENAI_MODEL_EXECUTION_GUIDANCE. A line with a tool in TOOL_LINES needs that tool.
EXECUTION_DISCIPLINE = """\
# Execution discipline
<tool_persistence>
- Use tools when they make the result more correct, more complete, or better supported.
- Do not stop early when one more tool call would make the result much better.
- If a tool gives an empty, partial, or very narrow result, try a broader or different query before you decide.
- Continue to call tools until the task is complete and you checked the result.
</tool_persistence>

<mandatory_tool_use>
Do not answer these from memory or from mental calculation. Use a tool:
- Arithmetic and calculations: use bash.
- Hashes, encodings, and checksums: use bash.
- The current time and date: use bash.
- System state (operating system, CPU, memory, disk, ports, processes): use bash.
- File contents, sizes, and line counts: use read or grep.
- Git history, branches, and diffs: use bash.
Your memory and the instructions of the user describe the user. They do not describe the computer that you run on.
</mandatory_tool_use>

<act_dont_ask>
When a question has one clear default meaning, act on it. Do not ask the user first. For example:
- "Is port 443 open?": check this computer.
- "What operating system am I on?": check the live system.
Ask the user only when the meaning changes the tool that you call.
</act_dont_ask>

<prerequisite_checks>
- Before an action, get the information that the action needs.
- Do not skip a step that gets information because the last action seems clear.
- If a task needs the output of an earlier step, do that step first.
</prerequisite_checks>

<verification>
Before your final answer, check these items:
- Correctness: the result satisfies each requirement.
- Grounding: tool output or the given context supports each fact.
- Format: the result has the format that the user asked for.
- Safety: before a step with side effects (file writes, commands, API calls), confirm its scope.
- Completion: "done" means that you checked each requirement that the user named, not only some of them.
</verification>

<external_state_verification>
- After a change to an external system (an API call, a message, a record), read the target again before \
you write that the change worked. A tool call that succeeds is not a task that succeeds.
- Do not check again a file edit that a tool already confirmed.
</external_state_verification>

<literal_preservation>
- Keep identifiers, commands, and values exactly as the user gave them. Do not "repair" a value that \
does not match a format.
</literal_preservation>

<missing_context>
- If you do not have the necessary context, do not guess.
- If a tool can get the information, use the tool.
- Ask the user only when no tool can get the information.
- If you must continue with incomplete information, write your assumptions.
</missing_context>"""

TOOL_LINES = {
    "- Arithmetic and calculations: use bash.\n": ("bash",),
    "- Hashes, encodings, and checksums: use bash.\n": ("bash",),
    "- The current time and date: use bash.\n": ("bash",),
    "- System state (operating system, CPU, memory, disk, ports, processes): use bash.\n": ("bash",),
    "- File contents, sizes, and line counts: use read or grep.\n": ("read", "grep"),
    "- Git history, branches, and diffs: use bash.\n": ("bash",),
}

# opencode gpt.txt: the working style of GPT models.
GPT_WORKING_STYLE = """\
# Working style
- Keep your changes consistent with the structure, names, style, and patterns of the code around them.
- A file or a change that you do not know can be work of the user. Look at it before you delete or replace it.
- Do not revert, reset, or discard changes that you did not make. Do not run destructive commands such as \
git reset --hard, git checkout --, or a recursive delete of a broad path, unless the user asked for that \
operation. If the target or the scope is not clear, ask first.
- Do not start subagents unless the user or the project instructions ask for them.
- Do not do work that the user did not ask for. An assumption that helps you make progress is \
correct only if it stays in the scope of the request.
- In the final answer, give the outcome first, not the steps that you did."""

# Hermes Agent GOOGLE_MODEL_OPERATIONAL_GUIDANCE, from opencode gemini.txt.
GOOGLE_RULES = """\
# Rules for Gemini and Gemma models
- Read the files and search the project before you make changes. Do not guess file contents.
- Do not assume that a library is available. Look at package.json, requirements.txt, Cargo.toml, \
or a similar file before you import it.
- Do not change code outside the scope of the request without a question to the user.
- Keep your text short: a few sentences, not paragraphs. Write about actions and results.
- Use flags such as -y, --yes, or --non-interactive, so that commands do not wait for input.
- Work until the task is fully done. Do not stop with a plan. Do the plan."""

# opencode kimi.txt.
KIMI_RULES = """\
# Rules for Kimi models
- When a request can be a question or a task, treat it as a task.
- To create or change code or files, use the write and edit tools. Code that is only in your reply is not saved.
- After you write code, run it or test it with bash. If a test fails, read the error, fix the code, and test again.
- Make the smallest change that gets the result.
- You can make many tool calls in one reply. When calls do not affect each other, make them in parallel.
- Reply in the language of the user.
- Do not run git commit, git push, git reset, git rebase, or other git changes unless the user asks for them."""

# opencode anthropic.txt (v2). Claude gets no enforcement block.
CLAUDE_COMMENTS = """\
# Code comments
Match the comment density of the code around your change. Where the code has no comments, add none. \
Add a comment only for behavior that the code does not make clear. The instructions of the user or the \
project come first."""

_SIZE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*b(?![a-z])")


def _name(model: str) -> str:
    """The model name without the provider name: "openrouter/openai/gpt-5" -> "openai/gpt-5"."""
    return model.split("/", 1)[-1].lower()


def _has(model: str, names: tuple[str, ...]) -> bool:
    name = _name(model)
    return any(n in name for n in names)


def is_small_model(model: str) -> bool:
    """True: the model name gives a size of at most SMALL_MODEL_BILLIONS billion parameters (for example
    qwen2.5-coder:7b). A mixture of experts such as qwen3-30b-a3b uses its full size (30b)."""
    sizes = [float(m.group(1)) for m in _SIZE.finditer(_name(model))]
    return bool(sizes) and max(sizes) <= SMALL_MODEL_BILLIONS


def execution_discipline(tool_names: Collection[str] | None) -> str:
    text = EXECUTION_DISCIPLINE
    if tool_names is not None:
        for line, needs in TOOL_LINES.items():
            if not any(t in tool_names for t in needs):
                text = text.replace(line, "")
    return text


def model_guidance(model: str, tool_names: Collection[str] | None = None) -> list[str]:
    """The prompt blocks for the model family, in order. Empty for a model with no known faults."""
    if _has(model, ("claude",)):
        return [CLAUDE_COMMENTS]
    blocks: list[str] = []
    if _has(model, ("gpt", "codex")):
        blocks.append(GPT_WORKING_STYLE)
    if _has(model, TOOL_USE_MODELS):
        blocks.append(TOOL_USE_ENFORCEMENT)
    if _has(model, GOOGLE_MODELS):
        blocks.append(GOOGLE_RULES)
    elif _has(model, EXECUTION_MODELS):
        blocks.append(execution_discipline(tool_names))
    if _has(model, KIMI_MODELS):
        blocks.append(KIMI_RULES)
    return blocks
