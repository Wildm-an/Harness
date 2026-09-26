from __future__ import annotations

import asyncio
import json

import pytest

from harness_daemon.permissions import PermissionGate, rule_matches
from harness_daemon.tools import Approval, BashTool, ReadTool


@pytest.mark.parametrize("rule,tool,key,expected", [
    ("bash", "bash", "anything", True),
    ("bash(git status)", "bash", "git status", True),
    ("bash(git status)", "bash", "git status --short", False),
    ("bash(npm run test:*)", "bash", "npm run test:unit", True),
    ("bash(npm run test:*)", "bash", "npm run test && rm -rf /", False),
    ("bash(git log:*)", "bash", "git log | sh", False),
    ("bash(git log:*)", "bash", "git log $(whoami)", False),
    ("edit(src/*.py)", "edit", "src/app.py", True),
    ("edit(src/*.py)", "edit", "tests/app.py", False),
    ("edit", "bash", "ls", False),
])
def test_rule_matches(rule, tool, key, expected):
    assert rule_matches(rule, tool, key) is expected


def test_allow_always_writes_project_rule(project):
    asked = []

    async def approver(request):
        asked.append(request)
        return "allow_always"

    gate = PermissionGate(project, approver)
    approval = Approval(key="git status", rule="bash(git status)")
    assert asyncio.run(gate.check(BashTool(), {"command": "git status"}, approval))
    data = json.loads((project / ".harness" / "settings.json").read_text())
    assert data["allow"] == ["bash(git status)"]
    # The second call matches the rule. The gate does not ask again.
    assert asyncio.run(gate.check(BashTool(), {"command": "git status"}, approval))
    assert len(asked) == 1


def test_deny_rule_wins(project):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash"], "deny": ["bash(rm:*)"]}))

    async def approver(request):
        raise AssertionError("The gate must not ask.")

    gate = PermissionGate(project, approver)
    assert not asyncio.run(gate.check(BashTool(), {}, Approval(key="rm -r x", rule="")))
    assert asyncio.run(gate.check(BashTool(), {}, Approval(key="ls", rule="")))


def test_tools_without_approval_pass(project):
    async def approver(request):
        raise AssertionError("The gate must not ask.")

    assert asyncio.run(PermissionGate(project, approver).check(ReadTool(), {}, None))
