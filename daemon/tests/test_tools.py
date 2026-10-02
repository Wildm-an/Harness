from __future__ import annotations

import asyncio
import sys
import time

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import BashTool, EditTool, ReadTool, ToolContext, ToolError, detect_shell, truncate


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def run(coro):
    return asyncio.run(coro)


def test_read_numbers_lines(ctx):
    out = run(ReadTool().run({"path": "hello.py"}, ctx)).output
    assert out.splitlines()[0] == "     1\tdef greet():"
    assert "     4\tprint(greet())" in out


def test_read_offset_and_limit(ctx):
    out = run(ReadTool().run({"path": "hello.py", "offset": "2", "limit": 1}, ctx)).output
    assert out.startswith("     2\t    return 'hello'")
    assert "Use offset=3 to read more" in out


# On macOS and Linux, "C:/Windows/win.ini" is a relative path in the project.
WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="a drive path is a Windows path")


@pytest.mark.parametrize("path", ["../outside.txt", "/etc/passwd", pytest.param("C:/Windows/win.ini", marks=WINDOWS_ONLY)])
def test_paths_outside_project_are_rejected(ctx, path):
    with pytest.raises(ToolError, match="outside the project"):
        run(ReadTool().run({"path": path}, ctx))


def test_read_missing_file(ctx):
    with pytest.raises(ToolError, match="not found"):
        run(ReadTool().run({"path": "nope.py"}, ctx))


def test_edit_replaces_unique_string(ctx, project):
    tool = EditTool()
    args = {"path": "hello.py", "old_string": "'hello'", "new_string": "'hi'"}
    approval = run(tool.prepare(args, ctx))
    assert approval.key == "hello.py"
    assert approval.rule == "edit(hello.py)"
    assert "-    return 'hello'" in approval.diff and "+    return 'hi'" in approval.diff
    result = run(tool.run(args, ctx))
    assert not result.is_error
    assert "return 'hi'" in (project / "hello.py").read_text()


def test_edit_rejects_ambiguous_string(ctx, project):
    (project / "dup.txt").write_text("a\na\n")
    with pytest.raises(ToolError, match="occurs 2 times"):
        run(EditTool().prepare({"path": "dup.txt", "old_string": "a", "new_string": "b"}, ctx))
    run(EditTool().run({"path": "dup.txt", "old_string": "a", "new_string": "b", "replace_all": True}, ctx))
    assert (project / "dup.txt").read_text() == "b\nb\n"


def test_edit_string_not_found(ctx):
    with pytest.raises(ToolError, match="not found"):
        run(EditTool().prepare({"path": "hello.py", "old_string": "nothing", "new_string": "x"}, ctx))


def test_edit_keeps_crlf_line_endings(ctx, project):
    (project / "crlf.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    run(EditTool().run({"path": "crlf.txt", "old_string": "one\ntwo", "new_string": "1\n2"}, ctx))
    assert (project / "crlf.txt").read_bytes() == b"1\r\n2\r\nthree\r\n"


def test_bash_output_and_exit_code(ctx):
    ok = run(BashTool().run({"command": "echo hello"}, ctx))
    assert ok.output.strip() == "hello" and not ok.is_error
    bad = run(BashTool().run({"command": "exit 3"}, ctx))
    assert bad.is_error and "[Exit code: 3]" in bad.output


def test_bash_runs_in_project_folder(ctx, project):
    out = run(BashTool().run({"command": "ls"}, ctx)).output
    assert "hello.py" in out


def test_bash_timeout_stops_the_process(ctx):
    start = time.monotonic()
    result = run(BashTool().run({"command": "sleep 30", "timeout": 1}, ctx))
    assert time.monotonic() - start < 10
    assert result.is_error and "timed out after 1 seconds" in result.output


def test_truncate_tells_the_model():
    text = "x" * 50
    assert truncate(text, 100) == text
    out = truncate(text, 20)
    assert out.startswith("x" * 20) and "Output truncated" in out and "50 characters" in out
