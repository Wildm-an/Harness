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
from dataclasses import dataclass


@dataclass(frozen=True)
class Family:
    id: str
    pattern: re.Pattern[str]


def _family(id: str, names: str) -> Family:
    # A name matches only as a whole word part: "gptq" (a quantization) is not "gpt". A digit can follow.
    return Family(id, re.compile(rf"(?<![a-z0-9])(?:{names})(?![a-z])"))


# The model families, in order: the first match wins. The lists follow Hermes Agent.
FAMILIES: tuple[Family, ...] = (
    _family("claude", "claude"),
    _family("gpt", "gpt|chatgpt|codex"),
    _family("gemini", "gemini"),
    _family("gemma", "gemma"),
    _family("grok", "grok"),
    _family("glm", "glm"),
    _family("qwen", "qwen|qwq"),
    _family("deepseek", "deepseek"),
    _family("kimi", "kimi|moonshot|moonshotai"),
    _family("minimax", "minimax"),
    _family("mimo", "mimo"),
    _family("mistral", "mistral|mistralai"),
)
FAMILY_IDS = tuple(f.id for f in FAMILIES)

# The prompt blocks of each family, in order. A family that is not here (or no family) gets no block.
FAMILY_BLOCKS: dict[str, tuple[str, ...]] = {
    "claude": ("claude_comments",),
    "gpt": ("gpt_style", "tool_use", "execution"),
    "gemini": ("tool_use", "google"),
    "gemma": ("tool_use", "google"),
    "grok": ("tool_use", "execution"),
    "glm": ("tool_use", "execution"),
    "qwen": ("tool_use", "execution"),
    "deepseek": ("tool_use", "execution"),
    "kimi": ("execution", "kimi"),
    "minimax": ("execution",),
    "mimo": ("execution",),
    "mistral": ("execution",),
}
# Families that get the "frontier" scaffold tier when they are not small. A tier gates scaffolds, for
# example the task list reminders (task_reminders). docs/PROMPT_LEDGER.md records the reason of each gate.
FRONTIER_FAMILIES = ("claude", "gpt", "gemini")
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


def model_family(model: str, override: str | None = None) -> str | None:
    """The family id of a model label ("provider/model"), or None.

    The last path segment counts first: "openai/gpt-5" is gpt. If it matches no family, the segment before it
    counts: "mistralai/codestral-2508" is mistral. The provider name (the first segment) never counts.
    ``override``: the "family" of the model in providers.json, a family id or "none".
    """
    if override is not None:
        return override if override in FAMILY_IDS else None
    segments = _name(model).split("/")
    for segment in (segments[-1], *reversed(segments[:-1])):
        for family in FAMILIES:
            if family.pattern.search(segment):
                return family.id
    return None


def scaffold_tier(model: str, family: str | None) -> str:
    """"small", "frontier", or "standard". A small model has a size of at most SMALL_MODEL_BILLIONS in its name."""
    if is_small_model(model):
        return "small"
    if family in FRONTIER_FAMILIES and "gpt-oss" not in _name(model):
        return "frontier"
    return "standard"


# The task list reminders, and the tiers that get each one with task_reminders "auto". All tiers get all
# reminders until the evaluation set (daemon/evals) shows which tier does not need one.
REMINDER_TIERS: dict[str, tuple[str, ...]] = {
    "plan_start": ("small", "standard", "frontier"),
    "plan_steer": ("small", "standard", "frontier"),
    "plan_open": ("small", "standard", "frontier"),
    "plan_stale": ("small", "standard", "frontier"),
}


def reminder_on(name: str, tier: str, setting: str | None) -> bool:
    """The setting "task_reminders": "auto" (by tier, the default), "on", or "off"."""
    if setting == "off":
        return False
    if setting == "on":
        return True
    return tier in REMINDER_TIERS.get(name, (tier,))


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


def model_guidance(model: str, tool_names: Collection[str] | None = None, family: str | None = None,
                   ablate: Collection[str] = ()) -> list[str]:
    """The prompt blocks for the model family, in order. Empty for a model with no known faults.

    ``family``: a family id that replaces the match of the name (the providers.json override).
    ``ablate``: block ids to leave out, for an evaluation run (the setting "prompt_ablate").
    """
    family = family if family is not None else model_family(model)
    texts = {
        "claude_comments": lambda: CLAUDE_COMMENTS,
        "gpt_style": lambda: GPT_WORKING_STYLE,
        "tool_use": lambda: TOOL_USE_ENFORCEMENT,
        "execution": lambda: execution_discipline(tool_names),
        "google": lambda: GOOGLE_RULES,
        "kimi": lambda: KIMI_RULES,
    }
    return [texts[block]() for block in FAMILY_BLOCKS.get(family or "", ()) if block not in ablate]
