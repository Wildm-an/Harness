"""The instruction files: HARNESS.md, AGENTS.md, or CLAUDE.md in the project, and the file of the user."""

from __future__ import annotations

from harness_daemon.prompt import BASE_AUTHORITY, load_project_instructions, load_user_instructions

from test_agent import make_agent


def test_the_first_project_file_wins(project):
    (project / "CLAUDE.md").write_text("claude rules")
    assert load_project_instructions(project).name == "CLAUDE.md"
    (project / "AGENTS.md").write_text("agents rules")
    assert load_project_instructions(project).text == "agents rules"
    (project / "HARNESS.md").write_text("harness rules")
    found = load_project_instructions(project)
    assert found.name == "HARNESS.md" and found.text == "harness rules"


def test_an_empty_file_does_not_count(project):
    (project / "HARNESS.md").write_text("  \n")
    (project / "AGENTS.md").write_text("agents rules")
    assert load_project_instructions(project).name == "AGENTS.md"


def test_a_worktree_with_no_file_uses_the_file_of_its_project(project):
    (project / "AGENTS.md").write_text("project rules")
    worktree = project / ".harness" / "worktrees" / "fix"
    worktree.mkdir(parents=True)
    assert load_project_instructions(worktree).text == "project rules"
    (worktree / "HARNESS.md").write_text("worktree rules")
    assert load_project_instructions(worktree).text == "worktree rules"


def test_the_user_file(harness_home, tmp_path):
    assert load_user_instructions() is None
    claude = tmp_path / "claude-home"
    (claude / "CLAUDE.md").write_text("Do not push.")
    found = load_user_instructions()
    assert found.text == "Do not push." and found.name.endswith("CLAUDE.md")
    (harness_home / "AGENTS.md").write_text("Use tabs.")
    assert load_user_instructions().text == "Use tabs."
    (harness_home / "HARNESS.md").write_text("Write short replies.")
    assert load_user_instructions().text == "Write short replies."


def test_a_long_user_file_is_cut(harness_home):
    (harness_home / "HARNESS.md").write_text("x" * 20_000)
    found = load_user_instructions()
    assert found.truncated and len(found.text) == 10_000


def test_the_agent_and_a_subagent_get_the_user_file(harness_home, project):
    (harness_home / "HARNESS.md").write_text("Never push to main.")
    agent, _, _ = make_agent(project)
    assert "# User instruction file" in agent.system_prompt and "Never push to main." in agent.system_prompt
    from harness_daemon.agent import Agent

    sub = Agent(cwd=project, client=agent.client, emit=agent.emit, approver=agent.gate.approver,
                settings=dict(agent.settings), user_facing=False)
    assert "Never push to main." in sub.system_prompt


def test_the_base_prompt_states_the_order_of_authority(harness_home, project):
    agent, _, _ = make_agent(project)
    assert BASE_AUTHORITY in agent.system_prompt
    assert "The messages of the user in this conversation come first." in BASE_AUTHORITY


# -- 6b: nested instruction files as notes ---------------------------------------------------------------

import asyncio  # noqa: E402

from harness_daemon.prompt import MAX_NESTED_FILES, nested_instruction_files  # noqa: E402

from test_agent import make_agent  # noqa: E402


def _read(path):
    return {"tool_calls": [{"name": "read", "arguments": {"path": path}}]}


def _nested(project):
    (project / "pkg" / "a").mkdir(parents=True)
    (project / "pkg" / "AGENTS.md").write_text("Outer rules.")
    (project / "pkg" / "a" / "HARNESS.md").write_text("Inner rules.")
    (project / "pkg" / "a" / "CLAUDE.md").write_text("Not this one.")
    (project / "pkg" / "a" / "x.py").write_text("x = 1\n")


def test_nested_files_outer_first_and_skipped_folders(project):
    _nested(project)
    found = nested_instruction_files(project, "pkg/a/x.py")
    assert [f.name for f in found] == ["AGENTS.md", "HARNESS.md"]
    (project / "node_modules" / "x").mkdir(parents=True)
    (project / "node_modules" / "x" / "AGENTS.md").write_text("hostile")
    assert nested_instruction_files(project, "node_modules/x/i.js") == []
    (project / ".git").mkdir(exist_ok=True)
    (project / ".git" / "AGENTS.md").write_text("hostile")
    assert nested_instruction_files(project, ".git/config") == []
    assert nested_instruction_files(project, project.parent / "elsewhere.py") == []
    assert nested_instruction_files(project, "hello.py") == []  # The root file is in the system prompt.


def test_a_read_adds_the_note_once_and_the_system_prompt_stays(harness_home, project, fake_model):
    _nested(project)
    fake_model.script(_read("pkg/a/x.py"), _read("pkg/a/x.py"), {"text": "Done."})
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("read it")) == "end"
    second = fake_model.requests[1]["messages"]
    assert second[0] == fake_model.requests[0]["messages"][0]  # The same system prompt.
    text = str(second[-1]["content"])
    assert "The folder pkg/ has the instruction file AGENTS.md" in text and "Outer rules." in text
    assert "The folder pkg/a/ has the instruction file HARNESS.md" in text and "Inner rules." in text
    assert text.index("Outer rules.") < text.index("Inner rules.") and "Not this one." not in text
    third = str(fake_model.requests[2]["messages"][-1]["content"])
    assert "has the instruction file" not in third  # The second read adds no note.


def test_a_long_file_is_cut_and_names_the_path(harness_home, project, fake_model):
    (project / "big").mkdir()
    (project / "big" / "AGENTS.md").write_text("rule\n" * 3000)
    (project / "big" / "f.py").write_text("")
    fake_model.script(_read("big/f.py"), {"text": "Done."})
    agent, _, _ = make_agent(project)
    asyncio.run(agent.run_turn("read it"))
    assert "Read big/AGENTS.md for the rest." in str(fake_model.requests[1]["messages"][-1]["content"])


def test_after_the_limit_the_note_is_a_pointer(harness_home, project, fake_model):
    for i in range(MAX_NESTED_FILES + 1):
        (project / f"d{i}").mkdir()
        (project / f"d{i}" / "AGENTS.md").write_text(f"rules {i}")
        (project / f"d{i}" / "f.py").write_text("")
    fake_model.script(*[_read(f"d{i}/f.py") for i in range(MAX_NESTED_FILES + 1)], {"text": "Done."})
    agent, _, _ = make_agent(project)
    asyncio.run(agent.run_turn("read them"))
    last = " ".join(str(m.get("content")) for m in fake_model.requests[-1]["messages"])
    assert f"The folder d{MAX_NESTED_FILES}/ has the instruction file AGENTS.md. The Harness did not load it" in last
    assert f"rules {MAX_NESTED_FILES}" not in last


def test_after_a_clear_the_next_touch_loads_the_file_again(harness_home, project, fake_model):
    _nested(project)
    fake_model.script(_read("pkg/a/x.py"), {"text": "Done."}, _read("pkg/a/x.py"), {"text": "Done."})
    agent, _, _ = make_agent(project)
    asyncio.run(agent.run_turn("read it"))
    agent.clear()
    asyncio.run(agent.run_turn("read it again"))
    assert "Outer rules." in str(fake_model.requests[-1]["messages"][-1]["content"])


def test_the_authority_block_names_the_nested_file():
    from harness_daemon.prompt import BASE_AUTHORITY

    assert "instruction file nearest to the file that you work on" in BASE_AUTHORITY
