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
