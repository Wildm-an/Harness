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
"""

from __future__ import annotations

import fnmatch
import re
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import project_settings_path, read_json, write_json
from .tools import Approval, Tool

RULE_RE = re.compile(r"([A-Za-z0-9_\-]+\*?)(?:\((.*)\))?", re.S)
SHELL_OPERATORS = re.compile(r"[;&|`\n<>]|\$\(")

DECISIONS = ("allow_once", "allow_always", "deny")

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
    def __init__(self, cwd: Path, approver: Approver, session_allow: list[str] | None = None):
        self.rules = PermissionRules(cwd)
        self.approver = approver
        # Rules for this gate only. A subagent gets the allowed-tools of its skill here.
        self.session_allow = list(session_allow or [])
        # Rules for the current turn: the allowed-tools of the skills that run in it.
        self.turn_allow: list[str] = []

    async def check(self, tool: Tool, args: dict[str, Any], approval: Approval | None) -> bool:
        if not tool.needs_approval or approval is None:
            return True
        name = approval.tool or tool.name
        if self.rules.denies(name, approval.key):
            return False
        if self.rules.allows(name, approval.key):
            return True
        if any(rule_matches(r, name, approval.key) for r in (*self.session_allow, *self.turn_allow)):
            return True
        decision = await self.approver({
            "request_id": uuid.uuid4().hex,
            "tool": tool.name,
            "input": approval.input if approval.input is not None else args,
            "diff": approval.diff,
            "rule": approval.rule,
        })
        if decision == "allow_always":
            self.rules.add_allow(approval.rule)
            return True
        return decision == "allow_once"
