"""Permission rules and the permission gate.

Rules live in ``<project>/.harness/settings.json``::

    { "allow": ["bash(git status)", "bash(npm run test:*)", "edit(src/*.py)"],
      "deny":  ["bash(rm -rf:*)"] }

Rule forms:

- ``tool`` matches every call of the tool.
- ``bash(<command>)`` matches the exact command.
- ``bash(<prefix>:*)`` matches a command that starts with the prefix. It does not
  match a command with shell operators such as ``;``, ``&&``, ``|``, or ``$(``.
- ``edit(<glob>)`` matches a relative file path with ``fnmatch`` rules.
- ``mcp__<server>__*`` (a tool name that ends with ``*``) matches each tool with that prefix,
  for example all the tools of one MCP server.

A deny rule has priority over an allow rule.

Permission modes (the ``permission_mode`` setting, as in Claude Code):

- ``default``: ask the user for each action that no rule allows.
- ``acceptEdits``: file changes in the project (edit, write) run with no question.
- ``plan``: file changes are blocked. The agent reads and makes a plan.
- ``auto``: a model checks each action that no rule decides (auto_mode.py, docs/AUTO_MODE.md).
- ``bypassPermissions``: every action runs with no question.

The deny rules apply in all modes.
"""

from __future__ import annotations

import fnmatch
import json
import re
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from .auto_mode import (
    BLOCK_MESSAGE,
    FAILURE_MESSAGE,
    MAX_CONSECUTIVE_BLOCKS,
    MAX_FAILURES,
    MAX_TOTAL_BLOCKS,
    AutoModeError,
    AutoReviewer,
    fast_path,
    hard_rule,
    is_broad_rule,
)
from .config import project_settings_path, read_json, write_json
from .tools import Approval, Tool

RULE_RE = re.compile(r"([A-Za-z0-9_\-]+\*?)(?:\((.*)\))?", re.S)
SHELL_OPERATORS = re.compile(r"[;&|`\n<>]|\$\(")

DECISIONS = ("allow_once", "allow_always", "deny")
MODES = ("default", "acceptEdits", "plan", "auto", "bypassPermissions")
EDIT_TOOLS = ("edit", "write")

PLAN_BLOCK = ("Plan mode is on, so you cannot change files. Read and search the project, then give the user "
              "a plan and stop. The user changes the mode to start the work.")

# The approver gets a request and returns one of DECISIONS.
Approver = Callable[[dict[str, Any]], Awaitable[str]]


def rule_matches(rule: str, tool: str, key: str) -> bool:
    m = RULE_RE.fullmatch(rule.strip())
    if not m:
        return False
    name, pattern = m.group(1), m.group(2)
    if name.endswith("*"):
        if not tool.lower().startswith(name[:-1].lower()):
            return False
    elif name.lower() != tool.lower():
        return False
    if pattern is None or pattern == "*":
        return True
    if tool == "bash":
        if pattern.endswith(":*"):
            if SHELL_OPERATORS.search(key):
                return False
            return key.startswith(pattern[:-2])
        return key == pattern
    return fnmatch.fnmatchcase(key, pattern)


def is_valid_rule(rule: object) -> bool:
    return isinstance(rule, str) and RULE_RE.fullmatch(rule.strip()) is not None


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


class PermissionRules:
    def __init__(self, cwd: Path):
        self.path = project_settings_path(cwd)

    def _rules(self, kind: str) -> list[str]:
        data = read_json(self.path, {})
        rules = data.get(kind, [])
        return [r for r in rules if isinstance(r, str)] if isinstance(rules, list) else []

    def allows(self, tool: str, key: str) -> bool:
        return any(rule_matches(r, tool, key) for r in self._rules("allow"))

    def denies(self, tool: str, key: str) -> bool:
        return any(rule_matches(r, tool, key) for r in self._rules("deny"))

    def read(self) -> dict[str, list[str]]:
        return {"allow": self._rules("allow"), "deny": self._rules("deny")}

    def write(self, allow: list[str], deny: list[str]) -> None:
        """Replace the rules. Keep the other keys of the settings file."""
        for rule in (*allow, *deny):
            if not is_valid_rule(rule):
                raise ValueError(f"Not a valid rule: {rule!r}. Use tool or tool(pattern).")
        data = read_json(self.path, {})
        data["allow"] = _unique([r.strip() for r in allow])
        data["deny"] = _unique([r.strip() for r in deny])
        write_json(self.path, data)

    def add_allow(self, rule: str) -> None:
        data = read_json(self.path, {})
        allow = data.setdefault("allow", [])
        if rule not in allow:
            allow.append(rule)
            write_json(self.path, data)


class PermissionGate:
    def __init__(self, cwd: Path, approver: Approver, session_allow: list[str] | None = None,
                 mode: Callable[[], str] | None = None):
        self.rules = PermissionRules(cwd)
        self.approver = approver
        self.mode = mode or (lambda: "default")
        # Rules for this gate only. A subagent gets the allowed-tools of its skill here.
        self.session_allow = list(session_allow or [])
        # Rules for the current turn: the allowed-tools of the skills that run in it.
        self.turn_allow: list[str] = []
        self.auto: AutoReviewer | None = None  # The checks of auto mode. The agent sets it.

    async def check(self, tool: Tool, args: dict[str, Any], approval: Approval | None,
                    force: str | None = None) -> bool | str:
        """True: run the action. False: the user denied it, and the turn stops.

        A text: the mode blocked the action. The text goes to the agent, and the turn continues.
        ``force``: a plugin asked for approval of this call, with this reason. The user decides,
        also when a rule or the mode allows the call. A deny rule still denies it.
        """
        if force is not None:
            key = approval.key if approval is not None else json.dumps(args, sort_keys=True, ensure_ascii=False)[:500]
            name = (approval.tool if approval is not None else None) or tool.name
            if self.rules.denies(name, key):
                return False
            decision = await self.approver({
                "request_id": uuid.uuid4().hex,
                "tool": tool.name,
                "input": approval.input if approval is not None and approval.input is not None else args,
                "diff": approval.diff if approval is not None else None,
                "rule": None,  # The plugin asks each time: "always" adds no rule.
                "reason": force,
            })
            return decision in ("allow_once", "allow_always")
        if not tool.needs_approval or approval is None:
            return True
        name = approval.tool or tool.name
        if self.rules.denies(name, approval.key):
            return False
        mode = self.mode()  # An unknown mode, for example a mode of an older version, is "default".
        if mode == "bypassPermissions":
            return True
        if mode == "auto" and self.auto is not None:
            return await self._auto_check(tool, name, args, approval)
        if self.rules.allows(name, approval.key):
            return True
        if any(rule_matches(r, name, approval.key) for r in (*self.session_allow, *self.turn_allow)):
            return True
        if name in EDIT_TOOLS:
            if mode == "plan":
                return PLAN_BLOCK
            if mode == "acceptEdits":
                return True
        return await self._ask(tool, args, approval)

    async def _ask(self, tool: Tool, args: dict[str, Any], approval: Approval, note: str | None = None) -> bool:
        """Ask the user. ``note`` tells why auto mode asks: the client shows it as the reason."""
        request: dict[str, Any] = {
            "request_id": uuid.uuid4().hex,
            "tool": tool.name,
            "input": approval.input if approval.input is not None else args,
            "diff": approval.diff,
            "rule": approval.rule,
        }
        if note:
            request["reason"] = note
        decision = await self.approver(request)
        if decision == "allow_always":
            self.rules.add_allow(approval.rule)
            return True
        return decision == "allow_once"

    async def _auto_check(self, tool: Tool, name: str, args: dict[str, Any], approval: Approval) -> bool | str:
        """Auto mode: the hard rules, the narrow allow rules, the fast paths, then the model."""
        auto = self.auto
        assert auto is not None
        label = hard_rule(name, approval.key)
        if label:
            return BLOCK_MESSAGE.format(rule=label, reason="A fixed rule of auto mode blocks this action. The user "
                                                             "can run it in another permission mode.")
        allow = [r for r in self.rules.read()["allow"] if not is_broad_rule(r)]
        if any(rule_matches(r, name, approval.key) for r in (*allow, *self.session_allow, *self.turn_allow)):
            return True
        if fast_path(name, approval.key):
            return True
        shown = approval.input if isinstance(approval.input, dict) else args
        try:
            verdict = await auto.review(name, shown, approval.key)
        except AutoModeError as e:
            auto.failures += 1
            if auto.failures >= MAX_FAILURES:
                auto.failures = 0
                return await self._ask(tool, args, approval, note=f"Auto mode could not check this action ({e}).")
            return FAILURE_MESSAGE.format(error=e)
        auto.failures = 0
        if verdict.decision == "allow":
            auto.consecutive_blocks = 0
            return True
        if verdict.decision == "ask":
            return await self._ask(tool, args, approval, note=f"Auto mode asks you: {verdict.reason}")
        auto.consecutive_blocks += 1
        auto.total_blocks += 1
        if auto.consecutive_blocks >= MAX_CONSECUTIVE_BLOCKS or auto.total_blocks >= MAX_TOTAL_BLOCKS:
            # Too many blocks: the user decides, as in Claude Code. Auto mode then continues.
            auto.consecutive_blocks = 0
            if auto.total_blocks >= MAX_TOTAL_BLOCKS:
                auto.total_blocks = 0
            return await self._ask(tool, args, approval, note=(
                f"Auto mode blocked this action [{verdict.rule}]: {verdict.reason} It blocked several actions, "
                "so it asks you."))
        return BLOCK_MESSAGE.format(rule=verdict.rule, reason=verdict.reason)
