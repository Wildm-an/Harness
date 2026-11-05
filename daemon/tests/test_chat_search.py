"""Search and reference chats: Storage.search_chats and the conversation_search tool."""

from __future__ import annotations

import asyncio

from harness_daemon.session import Session
from harness_daemon.storage import Storage
from harness_daemon.tools.chats import ConversationSearchTool

from test_agent import make_agent


def _session(storage: Storage, cwd, title: str, messages: list[dict]) -> str:
    session_id = storage.create_session(str(cwd), "fake", "m")
    storage.update_session(session_id, title=title)
    storage.append_messages(session_id, messages)
    return session_id


def test_search_finds_the_sessions_of_the_project(tmp_path, project):
    storage = Storage(tmp_path / "h.db")
    other = tmp_path / "other"
    other.mkdir()
    worktree = project / ".harness" / "worktrees" / "fix"
    old = _session(storage, project, "Release", [
        {"role": "user", "content": "How do we release? Push one tag."},
        {"role": "assistant", "content": [{"type": "text", "text": "Push the release tag, then wait for CI."}]},
        {"role": "tool", "content": "release tag output"},
    ])
    _session(storage, worktree, "Worktree", [{"role": "user", "content": "The release notes go in CHANGELOG.md."}])
    _session(storage, other, "Other", [{"role": "user", "content": "release tag elsewhere"}])
    current = _session(storage, project, "Now", [{"role": "user", "content": "release tag"}])

    hits = storage.search_chats(str(project), "Release TAG", exclude=current)
    assert [h["title"] for h in hits] == ["Release", "Worktree"]  # Two words match, then one word.
    assert hits[0]["id"] == old and [s["role"] for s in hits[0]["snippets"]] == ["user", "assistant"]
    assert storage.search_chats(str(project), "nothing-like-this") == []
    assert storage.search_chats(str(project), "100%_") == []


def test_the_tool_follows_the_setting(tmp_path, project, fake_model):
    storage = Storage(tmp_path / "h.db")
    _session(storage, project, "Release", [{"role": "user", "content": "Push one tag at a time."}])
    agent, _, _ = make_agent(project)
    session = Session(storage, storage.create_session(str(project), "fake", "m"), agent)
    assert "conversation_search" in agent.tools
    result = asyncio.run(agent.tools["conversation_search"].run({"query": "tag"}, agent.ctx))
    assert "## Release (" in result.output and "User: Push one tag at a time." in result.output
    agent.reload_settings({**agent.settings, "chat_search": False})
    assert "conversation_search" not in agent.tools
    assert session.agent is agent


def test_no_match_is_a_message():
    tool = ConversationSearchTool(lambda query, limit: [])
    assert "No past session" in asyncio.run(tool.run({"query": "x"}, None)).output  # type: ignore[arg-type]
