"""Command hooks from the settings files, in the form of Claude Code hooks.

The ``hooks`` key of ``~/.harness/settings.json`` and of ``<project>/.harness/settings.json``::

    { "hooks": {
        "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [ { "type": "command", "command": "...", "timeout": 60 } ] } ],
        "PostToolUse": [...], "UserPromptSubmit": [...], "Stop": [...], "SessionStart": [...] } }

The events:

- ``SessionStart``: before the first prompt of a session. The output goes to the agent as context.
- ``UserPromptSubmit``: before the agent reads a prompt of the user. Exit code 2 blocks the prompt.
  The output goes to the agent as context.
- ``PreToolUse``: before a tool call, after the checks of its arguments. Exit code 2, or the JSON
  ``{"decision": "block"}`` or ``{"hookSpecificOutput": {"permissionDecision": "deny"}}``, blocks the call.
  ``permissionDecision`` ``"allow"`` runs it with no question, and ``"ask"`` asks the user.
- ``PostToolUse``: after a tool call. Exit code 2 or ``{"decision": "block"}`` gives the reason to the agent.
- ``Stop``: the agent is about to end its turn. Exit code 2 or ``{"decision": "block"}`` makes it
  continue, with the reason as a message.

A hook gets the event as JSON on stdin: ``hook_event_name``, ``cwd``, ``session_id``,
``permission_mode``, and for the event ``prompt``, ``tool_name``, ``tool_input``, ``tool_response``, or
``stop_hook_active``. ``tool_name`` is the Claude Code name (``Bash``, ``Edit``) when the tool has one,
and ``harness_tool_name`` is the Harness name. A matcher is a regular expression for one of these names.
The command runs in the shell of the session with the environment variables ``HARNESS_PROJECT_DIR``
and ``CLAUDE_PROJECT_DIR``. Exit code 0 is a success. Other exit codes are errors that do not block.
``"disableAllHooks": true`` in a settings file turns off all the hooks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import harness_home, project_settings_path, read_json
from .tools.shell import ShellInfo, _kill_tree

log = logging.getLogger("harness.hooks")

EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")
TOOL_EVENTS = ("PreToolUse", "PostToolUse")
DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 600
MAX_OUTPUT = 10_000
BLOCK_EXIT = 2

# The Claude Code names of the Harness tools, so that hooks for Claude Code also match here.
CLAUDE_NAMES = {
    "bash": "Bash", "read": "Read", "edit": "Edit", "write": "Write", "glob": "Glob", "grep": "Grep",
    "web_fetch": "WebFetch", "web_search": "WebSearch", "agent": "Task", "skill": "Skill",
    "update_plan": "TodoWrite", "ask_user_question": "AskUserQuestion", "exit_plan_mode": "ExitPlanMode",
    "task_output": "BashOutput", "task_stop": "KillShell", "office_edit": "Edit",
}


@dataclass
class HookCommand:
    event: str
    matcher: str
    command: str
    timeout: int = DEFAULT_TIMEOUT
    source: str = ""  # The settings file.

    def matches(self, names: tuple[str, ...]) -> bool:
        if self.event not in TOOL_EVENTS or self.matcher in ("", "*"):
            return True
        try:
            pattern = re.compile(self.matcher)
        except re.error:
            return any(self.matcher == n for n in names)
        return any(pattern.fullmatch(n) for n in names)


@dataclass
class HookOutcome:
    """The result of all the hooks of one event."""

    blocked: str | None = None  # A reason: the prompt or the tool call is blocked, or the stop continues.
    decision: str | None = None  # PreToolUse: allow, ask, or deny.
    context: list[str] = field(default_factory=list)  # Text for the agent.
    errors: list[str] = field(default_factory=list)  # Hooks that failed with no block.


def _hook_list(data: Any, source: str) -> list[HookCommand]:
    out: list[HookCommand] = []
    if not isinstance(data, dict):
        return out
    for event, groups in data.items():
        if event not in EVENTS or not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict):
                continue
            matcher = str(group.get("matcher") or "")
            for hook in group.get("hooks") or []:
                if not isinstance(hook, dict) or hook.get("type", "command") != "command":
                    continue
                command = str(hook.get("command") or "").strip()
                if not command:
                    continue
                try:
                    timeout = int(hook.get("timeout") or DEFAULT_TIMEOUT)
                except (TypeError, ValueError):
                    timeout = DEFAULT_TIMEOUT
                out.append(HookCommand(event, matcher, command, max(1, min(timeout, MAX_TIMEOUT)), source))
    return out


# The hooks of each pair of settings files, with the size and time of each file when the daemon read it.
# The agent checks for hooks several times in each step. A file is read again only when it changed.
_hook_cache: dict[tuple[Path, ...], tuple[tuple, list[HookCommand]]] = {}


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


def load_hooks(cwd: Path | None) -> list[HookCommand]:
    """The hooks of the user settings, then of the project settings."""
    files = [harness_home() / "settings.json"]
    if cwd is not None:
        files.append(project_settings_path(cwd))
    key = tuple(files)
    stamps = tuple(_stamp(f) for f in files)
    cached = _hook_cache.get(key)
    if cached is not None and cached[0] == stamps:
        return list(cached[1])
    hooks = _read_hooks(files)
    _hook_cache[key] = (stamps, hooks)
    return list(hooks)


def _read_hooks(files: list[Path]) -> list[HookCommand]:
    datas = [(read_json(f, {}), str(f)) for f in files if f.is_file()]
    if any(isinstance(d, dict) and d.get("disableAllHooks") is True for d, _ in datas):
        return []
    hooks: list[HookCommand] = []
    for data, source in datas:
        if isinstance(data, dict):
            hooks.extend(_hook_list(data.get("hooks"), source))
    return hooks


def _run(argv: list[str], stdin: str, cwd: Path, env: dict[str, str], timeout: int) -> tuple[int | None, str, str, bool]:
    kwargs: dict[str, Any] = {"cwd": str(cwd), "stdin": subprocess.PIPE, "stdout": subprocess.PIPE,
                              "stderr": subprocess.PIPE, "env": env}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(argv, **kwargs)
    try:
        out, err = proc.communicate(stdin.encode("utf-8"), timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        out, err = proc.communicate()
        timed_out = True
    decode = lambda b: (b or b"").decode("utf-8", errors="replace").replace("\r\n", "\n").strip()[:MAX_OUTPUT]  # noqa: E731
    return proc.returncode, decode(out), decode(err), timed_out


class CommandHooks:
    """The hooks of one agent. The files are read again at each event, so that a change applies at once."""

    def __init__(self, cwd: Path, shell: ShellInfo, session_id: str | None = None):
        self.cwd = cwd
        self.shell = shell
        self.session_id = session_id

    def has(self, event: str) -> bool:
        return any(h.event == event for h in load_hooks(self.cwd))

    async def run(self, event: str, payload: dict[str, Any], tool: str | None = None) -> HookOutcome:
        names = (tool, CLAUDE_NAMES.get(tool, tool)) if tool else ()
        hooks = [h for h in load_hooks(self.cwd) if h.event == event and h.matches(tuple(n for n in names if n))]
        outcome = HookOutcome()
        if not hooks:
            return outcome
        body = {"hook_event_name": event, "cwd": str(self.cwd), "session_id": self.session_id, **payload}
        if tool:
            body["tool_name"] = CLAUDE_NAMES.get(tool, tool)
            body["harness_tool_name"] = tool
        stdin = json.dumps(body, ensure_ascii=False, default=str)
        env = {**os.environ, "HARNESS_PROJECT_DIR": str(self.cwd), "CLAUDE_PROJECT_DIR": str(self.cwd)}
        results = await asyncio.gather(*(asyncio.to_thread(
            _run, [*self.shell.argv, h.command], stdin, self.cwd, env, h.timeout) for h in hooks))
        for hook, (code, out, err, timed_out) in zip(hooks, results):
            if timed_out:
                outcome.errors.append(f"The {event} hook timed out after {hook.timeout} s: {hook.command}")
                continue
            if code == BLOCK_EXIT:
                outcome.blocked = outcome.blocked or err or out or f"A {event} hook blocked this (exit code 2)."
                continue
            if code != 0:
                outcome.errors.append(f"The {event} hook failed (exit code {code}): {hook.command}"
                                      + (f"\n{err}" if err else ""))
                continue
            self._read_output(event, out, outcome)
        return outcome

    @staticmethod
    def _read_output(event: str, out: str, outcome: HookOutcome) -> None:
        data: Any = None
        if out.startswith("{"):
            try:
                data = json.loads(out)
            except ValueError:
                data = None
        if not isinstance(data, dict):
            if out and event in ("SessionStart", "UserPromptSubmit"):
                outcome.context.append(out)
            return
        specific = data.get("hookSpecificOutput") if isinstance(data.get("hookSpecificOutput"), dict) else {}
        reason = str(data.get("reason") or specific.get("permissionDecisionReason") or "").strip()
        if data.get("decision") == "block" or data.get("continue") is False:
            outcome.blocked = outcome.blocked or reason or str(data.get("stopReason") or "") or f"A {event} hook blocked this."
        decision = specific.get("permissionDecision") or {"approve": "allow"}.get(str(data.get("decision")))
        if decision in ("allow", "ask", "deny"):
            # The strictest decision wins: deny, then ask, then allow.
            order = {"allow": 0, "ask": 1, "deny": 2}
            if outcome.decision is None or order[decision] > order[outcome.decision]:
                outcome.decision = decision
            if decision == "deny":
                outcome.blocked = outcome.blocked or reason or "A PreToolUse hook denied this tool call."
        extra = specific.get("additionalContext")
        if isinstance(extra, str) and extra.strip():
            outcome.context.append(extra.strip())
