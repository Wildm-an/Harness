"""The apply_patch tool (tools/apply_patch.py), Approval.keys in the permission gate, and the edit_tool setting."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from harness_daemon.agent import Agent
from harness_daemon.auto_mode import Verdict
from harness_daemon.config import DEFAULT_SETTINGS, load_settings
from harness_daemon.permissions import PLAN_BLOCK, PermissionGate
from harness_daemon.providers import ModelClient, resolve_model
from harness_daemon.tools import (
    APPLY_PATCH_FAMILIES,
    ApplyPatchTool,
    BashTool,
    ReadState,
    ToolContext,
    ToolError,
    detect_shell,
)
from harness_daemon.tools.apply_patch import BOUNDARY_ERROR, apply_update, parse_patch
from harness_daemon.tools.bash import NO_PATCH_COMMAND, PATCH_IS_A_TOOL


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project, settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def patch(*lines: str) -> str:
    return "\n".join(["*** Begin Patch", *lines, "*** End Patch"]) + "\n"


def run(ctx, text):
    return asyncio.run(ApplyPatchTool().run({"input": text}, ctx))


def prepare(ctx, text):
    return asyncio.run(ApplyPatchTool().prepare({"input": text}, ctx))


# -- the parser and apply_update ---------------------------------------------------------------------


def test_the_parser_reads_each_kind_of_section():
    ops = parse_patch(patch(
        "*** Add File: new.txt", "+one", "+two",
        "*** Delete File: old.txt",
        "*** Update File: a.py", "*** Move to: b.py", "@@ def f():", "-    pass", "+    return 1",
    ))
    assert [(op.kind, op.path, op.move_to) for op in ops] == [
        ("add", "new.txt", None), ("delete", "old.txt", None), ("update", "a.py", "b.py")]
    assert ops[0].lines == ["one", "two"]
    hunk = ops[2].hunks[0]
    assert (hunk.header, hunk.old, hunk.new) == ("def f():", ["    pass"], ["    return 1"])


def test_a_missing_end_marker_gives_the_fix():
    with pytest.raises(ToolError, match=r"must start with '\*\*\* Begin Patch' and end with '\*\*\* End Patch'"):
        parse_patch("*** Begin Patch\n*** Add File: a.txt\n+x\n")
    with pytest.raises(ToolError) as e:
        parse_patch("*** Add File: a.txt\n+x\n*** End Patch")
    assert str(e.value) == BOUNDARY_ERROR


def test_a_bad_line_names_its_line_number():
    with pytest.raises(ToolError, match="Line 4: 'oops' is not a hunk line"):
        parse_patch(patch("*** Update File: a.py", "@@", "oops"))
    with pytest.raises(ToolError, match="Line 3: 'x' is not a line of the new file"):
        parse_patch(patch("*** Add File: a.txt", "x"))


def test_an_update_with_no_hunk_fails():
    with pytest.raises(ToolError, match="has no hunk"):
        parse_patch(patch("*** Update File: a.py"))


def test_a_heredoc_wrapper_is_removed():
    text = "apply_patch <<'EOF'\n" + patch("*** Add File: a.txt", "+x") + "EOF\n"
    assert parse_patch(text)[0].lines == ["x"]
    assert parse_patch("<<EOF\n" + patch("*** Delete File: a.txt") + "EOF")[0].kind == "delete"


def test_two_hunks_apply_in_order():
    text = "a\nb\nc\nd\ne\nf\n"
    ops = parse_patch(patch("*** Update File: x", "@@", " a", "-b", "+B", "@@", " e", "-f", "+F"))
    assert apply_update(text, ops[0].hunks) == ("a\nB\nc\nd\ne\nF\n", None)


def test_the_header_line_selects_the_place():
    text = "def f():\n    return 1\n\ndef g():\n    return 1\n"
    ops = parse_patch(patch("*** Update File: x", "@@ def g():", "-    return 1", "+    return 2"))
    assert apply_update(text, ops[0].hunks)[0] == "def f():\n    return 1\n\ndef g():\n    return 2\n"


def test_end_of_file_matches_the_last_lines():
    text = "x = 1\nend\nx = 1\nend\n"
    ops = parse_patch(patch("*** Update File: x", "@@", " x = 1", "-end", "+done", "*** End of File"))
    assert apply_update(text, ops[0].hunks)[0] == "x = 1\nend\nx = 1\ndone\n"


def test_an_empty_line_in_an_update_is_context():
    text = "a\n\nb\n"
    ops = parse_patch(patch("*** Update File: x", "@@", " a", "", "-b", "+c"))
    assert apply_update(text, ops[0].hunks)[0] == "a\n\nc\n"


def test_a_hunk_with_only_added_lines_goes_at_the_end():
    ops = parse_patch(patch("*** Update File: x", "@@", "+last"))
    assert apply_update("a\nb\n", ops[0].hunks)[0] == "a\nb\nlast\n"


def test_crlf_stays():
    ops = parse_patch(patch("*** Update File: x", "@@", " a", "-b", "+c"))
    assert apply_update("a\r\nb\r\n", ops[0].hunks)[0] == "a\r\nc\r\n"


def test_a_tolerant_match_keeps_the_indentation_of_the_file():
    text = "class A:\n    def f(self):\n        return 1\n"
    ops = parse_patch(patch("*** Update File: x", "@@", " def f(self):", "-    return 1", "+    return 2"))
    assert apply_update(text, ops[0].hunks) == ("class A:\n    def f(self):\n        return 2\n", "indentation")


def test_a_tolerant_match_in_two_places_fails_with_the_lines():
    text = "  x = 1\n  y = 2\n\n  x = 1\n  y = 2\n"
    ops = parse_patch(patch("*** Update File: x", "@@", " x = 1", "-y = 2", "+y = 3"))
    with pytest.raises(ToolError, match=r"matches 2 places \(lines 1-2, 4-5\)"):
        apply_update(text, ops[0].hunks, "x")


# -- the tool ----------------------------------------------------------------------------------------


def test_add_delete_update_and_move(ctx, project):
    (project / "old.txt").write_text("bye\n")
    (project / "a.py").write_text("def f():\n    pass\n")
    result = run(ctx, patch(
        "*** Add File: src/new.txt", "+one",
        "*** Delete File: old.txt",
        "*** Update File: a.py", "*** Move to: b.py", "@@ def f():", "-    pass", "+    return 1",
        "*** Update File: hello.py", "@@", "-    return 'hello'", "+    return 'hi'",
    ))
    assert result.output.splitlines()[:6] == [
        "Applied the patch.", "A src/new.txt", "D old.txt", "D a.py", "A b.py", "M hello.py"]
    assert (project / "src" / "new.txt").read_text() == "one\n"
    assert not (project / "old.txt").exists() and not (project / "a.py").exists()
    assert (project / "b.py").read_text() == "def f():\n    return 1\n"
    assert "return 'hi'" in (project / "hello.py").read_text()
    assert {p.name for p in result.changed_paths} == {"new.txt", "old.txt", "a.py", "b.py", "hello.py"}
    assert "+++ b/src/new.txt" in result.diff and "+++ /dev/null" in result.diff


def test_a_wrong_context_changes_no_file(ctx, project):
    before = (project / "hello.py").read_bytes()
    with pytest.raises(ToolError, match="Update File hello.py: the context of hunk 1 was not found"):
        run(ctx, patch("*** Add File: new.txt", "+x",
                       "*** Update File: hello.py", "@@", "-nothing like this", "+x"))
    assert not (project / "new.txt").exists()
    assert (project / "hello.py").read_bytes() == before


def test_an_add_of_a_file_that_exists_fails(ctx):
    with pytest.raises(ToolError, match=r"Add File hello.py: the file exists. Use '\*\*\* Update File:'"):
        run(ctx, patch("*** Add File: hello.py", "+x"))


def test_a_path_outside_the_project_fails(ctx):
    with pytest.raises(ToolError, match=r"Add File \.\./evil.txt"):
        run(ctx, patch("*** Add File: ../evil.txt", "+x"))


def test_one_file_two_times_fails(ctx):
    with pytest.raises(ToolError, match="changes this file two times"):
        run(ctx, patch("*** Delete File: hello.py", "*** Update File: hello.py", "@@", "+x"))


def test_an_update_with_no_read_fails_and_a_read_passes(ctx, project):
    ctx.reads = ReadState()
    text = patch("*** Update File: hello.py", "@@", "-    return 'hello'", "+    return 'hi'")
    with pytest.raises(ToolError, match="You did not read hello.py"):
        prepare(ctx, text)
    with pytest.raises(ToolError, match="You did not read hello.py"):
        run(ctx, patch("*** Delete File: hello.py"))
    ctx.reads.note(project / "hello.py", (project / "hello.py").read_bytes())
    run(ctx, text)
    # The tool records the new text: a second patch needs no new read.
    run(ctx, patch("*** Update File: hello.py", "@@", "-    return 'hi'", "+    return 'yo'"))
    assert "'yo'" in (project / "hello.py").read_text()


def test_the_patch_alias_and_the_tolerant_note(ctx, project):
    (project / "a.py").write_text("x = 1   \ny = 2\n")
    result = asyncio.run(ApplyPatchTool().run(
        {"patch": patch("*** Update File: a.py", "@@", " x = 1", "-y = 2", "+y = 3")}, ctx))
    assert (project / "a.py").read_text() == "x = 1   \ny = 3\n"
    assert "ignored a difference in trailing whitespace" in result.output


def test_the_approval_has_a_key_for_each_path(ctx, project):
    one = prepare(ctx, patch("*** Add File: a.txt", "+x"))
    assert (one.key, one.keys, one.rule, one.tool) == ("a.txt", ("a.txt",), "edit(a.txt)", "edit")
    two = prepare(ctx, patch("*** Add File: a.txt", "+x", "*** Delete File: hello.py"))
    assert two.keys == ("a.txt", "hello.py") and two.rule == ""
    assert two.input["paths"] == ["a.txt", "hello.py"]


def test_bash_names_the_tool_in_patch_mode(ctx):
    command = {"command": "apply_patch <<'EOF'\n*** Begin Patch"}
    with pytest.raises(ToolError) as e:
        asyncio.run(BashTool().prepare(command, ctx))
    assert str(e.value) == NO_PATCH_COMMAND
    ctx.patch_mode = True
    with pytest.raises(ToolError) as e:
        asyncio.run(BashTool().prepare(command, ctx))
    assert str(e.value) == PATCH_IS_A_TOOL
    assert "Change a file: use apply_patch," in BashTool().describe(ctx)


# -- the permission gate -----------------------------------------------------------------------------


def gate_for(project, mode="default", decision="allow_once"):
    requests: list[dict] = []

    async def approver(request):
        requests.append(request)
        return decision

    return PermissionGate(project, approver, mode=lambda: mode), requests


def two_files(ctx):
    return prepare(ctx, patch("*** Add File: src/a.py", "+x", "*** Add File: docs/b.md", "+y"))


def check(gate, approval):
    return asyncio.run(gate.check(ApplyPatchTool(), {}, approval))


def test_a_deny_rule_for_one_path_blocks_the_patch(ctx, project):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"deny": ["edit(docs/*)"]}))
    gate, requests = gate_for(project)
    assert check(gate, two_files(ctx)) is False
    assert gate.last == ("deny", "deny_rule") and requests == []


def test_plan_mode_blocks_and_accept_edits_runs(ctx, project):
    approval = two_files(ctx)
    gate, _ = gate_for(project, "plan")
    assert check(gate, approval) == PLAN_BLOCK
    gate, requests = gate_for(project, "acceptEdits")
    assert check(gate, approval) is True and requests == []


def test_an_allow_rule_must_match_each_path(ctx, project):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["edit(src/*)"]}))
    gate, requests = gate_for(project)
    assert check(gate, two_files(ctx)) is True
    assert len(requests) == 1 and requests[0]["rule"] is None  # Several files: no "Always allow".
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["edit(src/*)", "edit(docs/*)"]}))
    gate, requests = gate_for(project)
    assert check(gate, two_files(ctx)) is True and requests == []


def test_allow_always_on_several_files_adds_no_rule(ctx, project):
    gate, _ = gate_for(project, decision="allow_always")
    assert check(gate, two_files(ctx)) is True
    assert not (project / ".harness" / "settings.json").exists()


def test_a_protected_path_in_a_patch_asks_in_accept_edits(ctx, project):
    approval = prepare(ctx, patch("*** Add File: src/a.py", "+x", "*** Add File: .github/workflows/ci.yml", "+y"))
    gate, requests = gate_for(project, "acceptEdits")
    assert check(gate, approval) is True
    assert len(requests) == 1 and requests[0]["rule"] is None
    assert requests[0]["reason"].startswith(".github/workflows/ci.yml is a protected path.")


def auto_gate(project, verdict="allow"):
    gate, requests = gate_for(project, "auto")
    reviewed: list[str] = []

    async def review(name, shown, key):
        reviewed.append(key)
        return Verdict(verdict, "Test", "a test verdict")

    gate.auto = SimpleNamespace(failures=0, consecutive_blocks=0, total_blocks=0, review=review)
    return gate, reviewed


def test_auto_mode_checks_each_path(ctx, project):
    gate, reviewed = auto_gate(project)
    assert check(gate, two_files(ctx)) is True and reviewed == []  # A fast path for each path.
    approval = prepare(ctx, patch("*** Add File: src/a.py", "+x", "*** Add File: .github/ci.yml", "+y"))
    assert check(gate, approval) is True and reviewed == ["src/a.py"]  # One protected path: the model checks.
    hard = prepare(ctx, patch("*** Add File: src/a.py", "+x", "*** Add File: .harness/settings.json", "+{}"))
    assert "Permission Settings" in check(gate, hard)


# -- the edit_tool setting and the agent -------------------------------------------------------------


def make_agent(project, decision="allow_once", **overrides):
    requests: list[dict] = []

    async def emit(event):
        return None

    async def approver(request):
        requests.append(request)
        return decision

    provider, model = resolve_model("fake/test-model")
    settings = load_settings(project)
    settings.update(overrides)
    agent = Agent(cwd=project, client=ModelClient(provider, model), emit=emit, approver=approver, settings=settings)
    return agent, requests


def names(agent):
    return [t["function"]["name"] for t in agent.tool_schemas()]


def test_the_default_keeps_edit_and_write(harness_home, project):
    agent, _ = make_agent(project)
    assert DEFAULT_SETTINGS["edit_tool"] == "edit" and APPLY_PATCH_FAMILIES == frozenset()
    assert "apply_patch" not in names(agent) and {"edit", "write"} <= set(names(agent))
    assert not agent.ctx.patch_mode
    auto, _ = make_agent(project, edit_tool="auto")  # No family is in APPLY_PATCH_FAMILIES yet.
    assert names(auto) == names(agent)


def test_patch_mode_puts_apply_patch_at_the_place_of_edit(harness_home, project):
    default = names(make_agent(project)[0])
    agent, _ = make_agent(project, edit_tool="apply_patch")
    tools = names(agent)
    assert tools == [("apply_patch" if n == "edit" else n) for n in default if n != "write"]
    prompt = agent.system_prompt + json.dumps(agent.tool_schemas())
    for text in ("edit tool", "write tool", "use edit", "edit or write", "use write"):
        assert text not in prompt, text
    assert "Use the apply_patch tool to create, change, or delete a file." in agent.system_prompt


def test_a_settings_change_keeps_the_tool_order(harness_home, project):
    agent, _ = make_agent(project)
    before = names(agent)
    agent.reload_settings({**agent.settings, "edit_tool": "apply_patch"})
    patched = names(agent)
    assert patched.index("apply_patch") == before.index("edit") and "write" not in patched
    agent.reload_settings({**agent.settings, "edit_tool": "edit"})
    assert names(agent) == before


def test_a_patch_turn_asks_once_and_checkpoints_each_path(harness_home, project, fake_model):
    (project / "old.txt").write_bytes(b"bye\n")
    text = patch("*** Add File: new.txt", "+hi", "*** Delete File: old.txt",
                 "*** Update File: hello.py", "@@", "-    return 'hello'", "+    return 'hi'")
    fake_model.script({"tool_calls": [{"name": "apply_patch", "arguments": {"input": text}}]}, {"text": "Done."})
    agent, requests = make_agent(project, edit_tool="apply_patch")
    checkpoints: dict[str, bytes | None] = {}
    agent.on_checkpoint = lambda message, path, content: checkpoints.setdefault(path, content)
    asyncio.run(agent.run_turn("change the files"))
    assert len(requests) == 1 and requests[0]["tool"] == "apply_patch"
    assert requests[0]["input"]["paths"] == ["new.txt", "old.txt", "hello.py"]
    assert checkpoints == {"new.txt": None, "old.txt": b"bye\n",
                           "hello.py": b"def greet():\n    return 'hello'\n\nprint(greet())\n"}
    assert (project / "new.txt").exists() and not (project / "old.txt").exists()
