"""The tolerant match of the edit tool (tools/match.py)."""

from __future__ import annotations

import asyncio

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import BashTool, EditTool, ToolContext, ToolError, detect_shell


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project, settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def edit(ctx, path, old, new, **extra):
    return asyncio.run(EditTool().run({"path": path, "old_string": old, "new_string": new, **extra}, ctx))


def test_an_exact_match_has_no_note(ctx, project):
    result = edit(ctx, "hello.py", "'hello'", "'hi'")
    assert result.output == "Edited hello.py."


def test_trailing_spaces_in_the_file(ctx, project):
    (project / "a.py").write_text("x = 1   \ny = 2\n")
    result = edit(ctx, "a.py", "x = 1\ny = 2", "x = 10\ny = 2")
    assert (project / "a.py").read_text() == "x = 10\ny = 2\n"
    assert "ignored a difference in trailing whitespace and replaced lines 1-2" in result.output


def test_a_python_block_with_more_indentation_in_the_file(ctx, project):
    (project / "a.py").write_text("class A:\n    def f(self):\n        return 1\n")
    edit(ctx, "a.py", "def f(self):\n    return 1\n", "def f(self):\n    if True:\n        return 2\n")
    assert (project / "a.py").read_text() == "class A:\n    def f(self):\n        if True:\n            return 2\n"


def test_a_block_with_less_indentation_in_the_file(ctx, project):
    (project / "a.py").write_text("def f():\n    return 1\n")
    edit(ctx, "a.py", "    def f():\n        return 1", "    def f():\n        return 3")
    assert (project / "a.py").read_text() == "def f():\n    return 3\n"


def test_a_makefile_with_tabs_and_old_string_with_spaces(ctx, project):
    (project / "Makefile").write_text("build:\n\tgcc -o app main.c\n")
    edit(ctx, "Makefile", "build:\n    gcc -o app main.c", "build:\n    gcc -O2 -o app main.c")
    assert (project / "Makefile").read_text() == "build:\n\tgcc -O2 -o app main.c\n"


def test_a_new_line_that_the_rule_cannot_convert_fails(ctx, project):
    (project / "Makefile").write_text("build:\n\tgcc main.c\n")
    with pytest.raises(ToolError, match="not found"):
        edit(ctx, "Makefile", "build:\n    gcc main.c", "build:\n   gcc main.c")  # 3 spaces: no tab count.


def test_whitespace_inside_a_line_does_not_count(ctx, project):
    (project / "a.py").write_text('s = "a  b"\n')
    with pytest.raises(ToolError, match="not found"):
        edit(ctx, "a.py", 's = "a b"', 's = "c"')


def test_a_fragment_inside_a_line_matches_only_exactly(ctx, project):
    (project / "a.py").write_text("value = compute(1)  \n")
    with pytest.raises(ToolError, match="not found"):
        edit(ctx, "a.py", "compute(1)   ", "compute(2)")


def test_two_tolerant_matches_are_an_error_with_the_lines(ctx, project):
    (project / "a.py").write_text("if a:\n    x = 1  \nif b:\n        x = 1  \n")
    with pytest.raises(ToolError, match=r"matches 2 places \(lines 2-2, 4-4\)"):
        edit(ctx, "a.py", "x = 1\n", "x = 2\n")


def test_replace_all_needs_an_exact_match(ctx, project):
    (project / "a.py").write_text("x = 1  \n")
    with pytest.raises(ToolError, match="replace_all needs an exact match"):
        edit(ctx, "a.py", "x = 1\n", "x = 2\n", replace_all=True)


def test_crlf_stays(ctx, project):
    (project / "a.py").write_bytes(b"x = 1  \r\ny = 2\r\n")
    edit(ctx, "a.py", "x = 1\ny = 2\n", "x = 3\ny = 2\n")
    assert (project / "a.py").read_bytes() == b"x = 3\r\ny = 2\r\n"


def test_the_setting_turns_the_tolerant_match_off(ctx, project):
    (project / "a.py").write_text("x = 1   \n")
    ctx.settings["edit_tolerant_match"] = False
    with pytest.raises(ToolError, match="not found"):
        edit(ctx, "a.py", "x = 1\n", "x = 2\n")


def test_the_approval_diff_shows_the_reindented_lines(ctx, project):
    (project / "a.py").write_text("class A:\n    x = 1\n")
    approval = asyncio.run(EditTool().prepare({"path": "a.py", "old_string": "x = 1", "new_string": "x = 2"}, ctx))
    assert "+    x = 2" in approval.diff


def test_apply_patch_in_bash_gets_the_tool_names(ctx):
    with pytest.raises(ToolError, match="no apply_patch command. Use the edit tool"):
        asyncio.run(BashTool().prepare({"command": "apply_patch <<'EOF'\n*** Begin Patch"}, ctx))
