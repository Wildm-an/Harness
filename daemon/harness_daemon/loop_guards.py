"""Guards in the tool loop: tool name repair, the repeated call reminder, and the stall nudge.

The ideas come from other agent harnesses (see docs/research/TOOL_USE_AND_PROMPTS.md):
- Hermes Agent and opencode repair tool names that have the wrong case or form.
- DeepSeek Harness and Hermes Agent tell the model when it repeats the same call.
- Hermes Agent continues a reply that says what it will do next but makes no tool call.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection
from typing import Any

# Names that models trained on other harnesses use, and the Harness tool for each.
TOOL_ALIASES = {
    "read_file": "read", "view": "read", "view_file": "read", "cat": "read", "open_file": "read",
    "write_file": "write", "create_file": "write",
    "edit_file": "edit", "str_replace": "edit", "str_replace_editor": "edit",
    "shell": "bash", "terminal": "bash", "run_command": "bash", "execute_command": "bash",
    "run_terminal_cmd": "bash", "powershell": "bash",
    "search_files": "grep", "grep_search": "grep", "rg": "grep",
    "find_files": "glob", "file_search": "glob", "list_files": "glob",
    "todo_write": "update_plan", "todowrite": "update_plan",
    "task": "agent", "fetch": "web_fetch", "webfetch": "web_fetch", "websearch": "web_search",
}


def _snake(name: str) -> str:
    """CamelCase to snake_case: ReadFile -> read_file."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name).lower()


def repair_tool_name(name: str, tools: Collection[str]) -> str | None:
    """The tool that a wrong tool name means, or None. Only exact rules, no guesses.

    The rules: trim quotes and tag fragments, remove a "functions." prefix, fix the case,
    change "-" and spaces to "_", change CamelCase to snake_case, remove a "_tool" suffix,
    and map common names of other harnesses (TOOL_ALIASES).
    """
    if name in tools:
        return name
    base = name.strip().strip("\"'`<>/ ")
    for prefix in ("functions.", "function.", "tools."):
        if base.lower().startswith(prefix):
            base = base[len(prefix):]
    lower = {t.lower(): t for t in tools}
    forms: list[str] = []
    for form in (base, _snake(base), base.lower()):
        form = re.sub(r"[-\s]+", "_", form)
        forms.append(form)
        if form.endswith("_tool"):
            forms.append(form[: -len("_tool")])
    for form in forms:
        if form in tools:
            return form
        if form.lower() in lower:
            return lower[form.lower()]
        alias = TOOL_ALIASES.get(form.lower())
        if alias in tools:
            return alias
    return None


def repaired_note(called: str, name: str) -> str:
    return f'[There is no tool "{called}". This call ran as "{name}". Use the name "{name}" next time.]'


# The repeated call reminder: the same tool, the same arguments, and the same result in one turn.
REPEAT_FIRST = 3  # The count of the first, short reminder.
REPEAT_STRONG = 5  # From this count, each repeat gets the strong reminder.


def repeat_key(name: str, args: dict[str, Any] | None, output: str) -> str:
    """The key of a call and its result. The "description" argument is only for the user."""
    shown = {k: v for k, v in (args or {}).items() if k != "description"}
    text = json.dumps([name, shown], sort_keys=True, default=str) + "\0" + output
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def repeat_note(name: str, count: int) -> str | None:
    """The reminder for the count of identical calls with identical results, or None."""
    if count >= REPEAT_STRONG:
        return (f"[You called {name} with these exact arguments {count} times in this turn, and the result "
                "did not change. The calls do not make progress. Do not call this tool with these arguments "
                "again. Read the latest result. Then choose a different action, or finish the task.]")
    if count == REPEAT_FIRST:
        return (f"[You called {name} with these exact arguments 3 times in this turn, and the result did not "
                "change. Look at the result before you call it again. Try a different approach if it does not help.]")
    return None


# The stall nudge: a short reply that says what the model will do now, with no tool call.
MAX_STALL_NUDGES = 2  # The nudges for each turn.
MAX_STALL_CHARS = 500  # A longer reply is a report, not a stall.
STALL_NUDGE = ("[Harness: Your reply said what you will do next, but it made no tool call. "
               "Do that step now with a tool call. If the task is complete, give your final answer to the user.]")
STALL_NOTICE = "The model said what it will do next but made no tool call. The Harness asked it to continue."

_INTENT = r"(?:i will|i'll|i am going to|i'm going to|let me|let's|i need to|i should)"
_STALL_PATTERNS = (
    re.compile(rf"\b{_INTENT}\s+now\b"),  # "I will now edit the file."
    re.compile(rf"^(?:now|next|then),?\s+{_INTENT}\b"),  # "Next, I will run the tests."
)


def _last_sentence(text: str) -> str:
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", lines[-1])
    return parts[-1].strip().lower().replace("’", "'")


def is_stall(text: str | None) -> bool:
    """True: a short reply that ends with a step that the model will do now, but no tool call."""
    if not text or len(text.strip()) > MAX_STALL_CHARS:
        return False
    sentence = _last_sentence(text)
    if not sentence or sentence.endswith("?") or "let me know" in sentence:
        return False
    if sentence.endswith(":") and re.search(rf"\b{_INTENT}\b", sentence):
        return True  # "Let me check the file:"
    return any(p.search(sentence) for p in _STALL_PATTERNS)
