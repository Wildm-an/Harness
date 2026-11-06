"""Tests for update_plan and wrap_up (tools/progress.py)."""

from __future__ import annotations

import asyncio

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import ToolContext, ToolError, WrapUpTool, detect_shell
from harness_daemon.tools.progress import MAX_ASK, MAX_RECAP


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def wrap(ctx, **args):
    return asyncio.run(WrapUpTool().run(args, ctx))


def test_wrap_up_keeps_the_recap_short(ctx):
    assert not wrap(ctx, recap="The fix is in. Nothing is committed.").is_error
    assert not wrap(ctx, recap="x" * MAX_RECAP).is_error
    with pytest.raises(ToolError, match=f"{MAX_RECAP + 1} characters"):
        wrap(ctx, recap="x" * (MAX_RECAP + 1))
    with pytest.raises(ToolError, match="ask has more than"):
        wrap(ctx, recap="Done.", ask="?" * (MAX_ASK + 1), actions=[{"label": "Yes"}])
    assert f"{MAX_RECAP} characters or less" in WrapUpTool.description
