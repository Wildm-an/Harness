"""The permission modes of the gate: default, acceptEdits, plan, and bypassPermissions."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from harness_daemon.permissions import PLAN_BLOCK, PermissionGate
from harness_daemon.tools import Approval

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


@dataclass
class FakeTool:
    name: str
    needs_approval: bool = True


BASH = (FakeTool("bash"), Approval(key="rm -rf build", rule="bash(rm -rf build)"))
EDIT = (FakeTool("edit"), Approval(key="src/app.py", rule="edit(src/app.py)"))


class Gate:
    """A gate in one mode, with a recorded approver."""

    def __init__(self, project: Path, mode: str, answer: str = "allow_once"):
        self.asked: list[dict] = []

        async def approver(request: dict) -> str:
            self.asked.append(request)
            return answer

        self.gate = PermissionGate(project, approver, mode=lambda: mode)

    def check(self, call: tuple[FakeTool, Approval]) -> bool | str:
        tool, approval = call
        return asyncio.run(self.gate.check(tool, {"command": approval.key}, approval))


def test_default_mode_asks(project):
    g = Gate(project, "default")
    assert g.check(BASH) is True and g.check(EDIT) is True and len(g.asked) == 2


def test_accept_edits_runs_the_edits_and_asks_for_the_rest(project):
    g = Gate(project, "acceptEdits")
    assert g.check(EDIT) is True and g.asked == []
    assert g.check(BASH) is True and [r["tool"] for r in g.asked] == ["bash"]


def test_plan_mode_blocks_the_edits(project):
    g = Gate(project, "plan")
    assert g.check(EDIT) == PLAN_BLOCK and g.asked == []
    assert g.check(BASH) is True and len(g.asked) == 1  # Other actions ask, as in the default mode.


def test_bypass_runs_everything_but_the_deny_rules(project):
    (project / ".harness").mkdir(exist_ok=True)
    (project / ".harness" / "settings.json").write_text(json.dumps({"deny": ["bash(rm -rf:*)"]}))
    g = Gate(project, "bypassPermissions")
    assert g.check(EDIT) is True and g.asked == []
    assert g.check(BASH) is False  # The deny rule applies in all modes.


def test_an_unknown_mode_asks(project):
    g = Gate(project, "auto")  # The auto mode of an older version.
    assert g.check(EDIT) is True and g.check(BASH) is True and len(g.asked) == 2


def test_modes_through_the_daemon(daemon, project, fake_model):  # noqa: F811
    (project / ".harness").mkdir(exist_ok=True)
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "dontAsk"}))
    c = Client(daemon)
    ready = c.new_session(project)
    assert ready["permission_mode"] == "default"  # An unknown setting (for example of another tool) is the default mode.

    c.send({"type": "settings.set", "permission_mode": "plan"})
    assert c.until("settings")[0]["permission_mode"] == "plan"
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "The plan: change the greeting."},
    )
    c.send({"type": "prompt", "text": "Change the greeting"})
    events = c.until("turn.end")[1]
    result = next(e for e in events if e["type"] == "tool.result")
    assert result["is_error"] and result["output"] == PLAN_BLOCK
    assert not any(e["type"] == "permission.request" for e in events)
    assert "'hello'" in (project / "hello.py").read_text()
    # The system prompt tells the model about plan mode.
    assert "Plan mode is on" in fake_model.requests[-1]["messages"][0]["content"]

    c.send({"type": "settings.set", "permission_mode": "yolo"})
    assert "must be one of" in c.until("error")[0]["message"]
    c.close()


def test_session_new_sets_the_mode_of_the_start_page(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model", "permission_mode": "auto"})
    ready = c.until("session.ready")[0]
    assert ready["permission_mode"] == "auto"
    assert json.loads((project / ".harness" / "settings.json").read_text())["permission_mode"] == "auto"
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model", "permission_mode": "yolo"})
    assert "must be one of" in c.until("error")[0]["message"]
    c.close()
