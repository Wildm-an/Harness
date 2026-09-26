"""Tests for skills: parsing, discovery, substitution, the skill tool, forks, and / commands."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from harness_daemon.agent import Agent
from harness_daemon.config import load_settings
from harness_daemon.providers import ModelClient, resolve_model
from harness_daemon.skills import discover_skills, load_skill, split_arguments, substitute

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def make_skill(root: Path, folder: str, frontmatter: str, body: str = "Do the task.") -> Path:
    path = root / folder / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{frontmatter}\n---\n{body}\n", encoding="utf-8")
    return path


# -- parsing --------------------------------------------------------------------------


def test_parse_all_fields(tmp_path):
    path = make_skill(tmp_path, "review", """name: review
description: >-
  Review code for bugs.
  Use it before a merge.
disable-model-invocation: true
user-invocable: false
allowed-tools: Bash(git diff:*), Read
argument-hint: "[path]"
context: fork
version: 2""")
    s = load_skill(path, "project", ".harness")
    assert s.name == "review"
    assert s.description == "Review code for bugs. Use it before a merge."
    assert (s.disable_model_invocation, s.user_invocable, s.context) == (True, False, "fork")
    assert s.allowed_tools == ("Bash(git diff:*)", "Read")
    assert s.argument_hint == "[path]" and s.extra == {"version": 2}
    assert s.body() == "Do the task."


def test_defaults_and_description_from_the_body(tmp_path):
    path = tmp_path / "Plain-Skill" / "SKILL.md"
    path.parent.mkdir()
    path.write_text("# Title\n\nThe first paragraph\nhas two lines.\n\nMore text.\n", encoding="utf-8")
    s = load_skill(path, "user", ".claude")
    assert s.name == "Plain-Skill" and s.description == "The first paragraph has two lines."
    assert s.model_invocable and s.user_invocable and s.allowed_tools == ()


def test_yaml_that_is_not_strict_still_loads(tmp_path):
    path = make_skill(tmp_path, "loose", "name: loose\ndescription: Use it: when the YAML is loose")
    assert load_skill(path, "user", ".claude").description == "Use it: when the YAML is loose"


def test_list_form_of_allowed_tools_and_bad_names(tmp_path):
    path = make_skill(tmp_path, "a", "name: a\nallowed-tools:\n  - Read\n  - Bash(ls)")
    assert load_skill(path, "user", ".claude").allowed_tools == ("Read", "Bash(ls)")
    bad = make_skill(tmp_path, "b", "name: 'bad name!'")
    assert load_skill(bad, "user", ".claude") is None


def test_discovery_priority(tmp_path, monkeypatch):
    claude, harness, project = tmp_path / "claude", tmp_path / "harness", tmp_path / "project"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("HARNESS_HOME", str(harness))
    make_skill(claude / "skills", "one", "name: one\ndescription: user claude")
    make_skill(claude / "skills", "two", "name: two\ndescription: user claude")
    make_skill(harness / "skills", "two", "name: two\ndescription: user harness")
    make_skill(project / ".claude" / "skills", "two", "name: two\ndescription: project claude")
    make_skill(project / ".claude" / "skills", "three", "name: three\ndescription: project claude")
    make_skill(project / ".harness" / "skills", "three", "name: three\ndescription: project harness")
    skills = discover_skills(project)
    assert {n: s.description for n, s in skills.items()} == {
        "one": "user claude", "two": "project claude", "three": "project harness"}
    assert skills["three"].source_label == "project (.harness)"


# -- substitution -------------------------------------------------------------------------


def test_substitution():
    body = "a=$0 b=$1 c=$2 all=$ARGUMENTS second=$ARGUMENTS[1] ten=$10 s=${CLAUDE_SKILL_DIR} p=${HARNESS_PROJECT_DIR}"
    out = substitute(body, 'x "y z"', Path("/s"), Path("/p"))
    assert out == f'a=x b=y z c= all=x "y z" second=y z ten= s={Path("/s")} p={Path("/p")}'


def test_arguments_are_added_when_there_is_no_placeholder():
    assert substitute("Body.", "file.py", Path("/s"), Path("/p")) == "Body.\n\nARGUMENTS: file.py"
    assert substitute("Body.", "", Path("/s"), Path("/p")) == "Body."
    assert split_arguments('a "unclosed') == ["a", '"unclosed']


# -- the agent ------------------------------------------------------------------------------


def skill_agent(project, skills_root, events=None, requests=None, decision="allow_once"):
    events = events if events is not None else []
    requests = requests if requests is not None else []

    async def emit(event):
        events.append(event)

    async def approver(request):
        requests.append(request)
        return decision

    provider, model = resolve_model("fake/m")
    return Agent(cwd=project, client=ModelClient(provider, model), emit=emit, approver=approver,
                 settings=load_settings(project), skills=discover_skills(project)), events, requests


@pytest.fixture
def project_skills(project, harness_home):
    root = project / ".harness" / "skills"
    make_skill(root, "greet", "name: greet\ndescription: Greet a person by name.\nallowed-tools: Bash(echo hi)",
               "Say hello to $0. Reference: ${CLAUDE_SKILL_DIR}/notes.md")
    (root / "greet" / "notes.md").write_text("Be kind.", encoding="utf-8")
    make_skill(root, "secret", "name: secret\ndescription: Only for the user.\ndisable-model-invocation: true")
    make_skill(root, "hidden", "name: hidden\ndescription: Only for the model.\nuser-invocable: false")
    make_skill(root, "research", "name: research\ndescription: Research in a subagent.\ncontext: fork",
               "Find $ARGUMENTS in the project.")
    make_skill(root, "help", "name: help\ndescription: A skill that a built-in command hides.")
    return root


def test_model_invokes_a_skill(project, project_skills, fake_model):
    agent, events, requests = skill_agent(project, project_skills)
    prompt = agent.system_prompt
    assert "- greet: Greet a person by name." in prompt and "secret" not in prompt.split("# Skills")[1]
    assert "skill" in agent.tools
    fake_model.script(
        {"tool_calls": [{"name": "skill", "arguments": {"name": "greet", "arguments": "Ada"}}]},
        {"tool_calls": [{"name": "read", "arguments": {"path": str(project_skills / "greet" / "notes.md")}}]},
        {"tool_calls": [{"name": "bash", "arguments": {"command": "echo hi"}}]},
        {"text": "Hello, Ada."},
    )
    assert asyncio.run(agent.run_turn("greet Ada")) == "end"
    results = [e for e in events if e["type"] == "tool.result"]
    assert "Say hello to Ada." in results[0]["output"] and str(project_skills / "greet") in results[0]["output"]
    assert "Be kind." in results[1]["output"]  # The skill folder is readable.
    assert not results[2]["is_error"] and requests == []  # allowed-tools: no approval in this turn.

    # The allowed-tools of the skill end with the turn.
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "echo hi"}}]}, {"text": "ok"})
    asyncio.run(agent.run_turn("again"))
    assert len(requests) == 1


def test_model_cannot_invoke_a_user_only_skill_or_write_to_skill_folders(project, project_skills, fake_model):
    agent, events, _ = skill_agent(project, project_skills)
    fake_model.script(
        {"tool_calls": [
            {"name": "skill", "arguments": {"name": "secret"}},
            {"name": "write", "arguments": {"path": str(project_skills / "greet" / "x.md"), "content": "x"}},
        ]},
        {"text": "ok"},
    )
    asyncio.run(agent.run_turn("try"))
    results = [e for e in events if e["type"] == "tool.result"]
    assert "Unknown skill: secret" in results[0]["output"]
    # The skill folder is under the project in this test, so try a folder outside the project.
    outside = Path(os.path.abspath(project / ".." / "elsewhere.md"))
    fake_model.script({"tool_calls": [{"name": "write", "arguments": {"path": str(outside), "content": "x"}}]},
                      {"text": "ok"})
    events.clear()
    asyncio.run(agent.run_turn("write outside"))
    assert "outside the project" in next(e for e in events if e["type"] == "tool.result")["output"]


def test_forked_skill_runs_in_a_subagent(project, project_skills, fake_model):
    agent, events, _ = skill_agent(project, project_skills)
    fake_model.script(
        {"text": "Main: start.", "tool_calls": [{"name": "skill", "arguments": {"name": "research", "arguments": "TODO"}}]},
        {"text": "Sub: I read.", "tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"text": "REPORT: no TODO found."},
        {"text": "Main: done."},
    )
    assert asyncio.run(agent.run_turn("research")) == "end"
    sub_request = fake_model.requests[1]["messages"]
    assert len(sub_request) == 2 and "Find TODO in the project." in sub_request[1]["content"]  # A new context.
    assert "skill" not in {t["function"]["name"] for t in fake_model.requests[1]["tools"]}
    sub_read = next(e for e in events if e["type"] == "tool.start" and e["name"] == "read")
    assert sub_read["agent"] == "research"
    tokens = "".join(e["text"] for e in events if e["type"] == "token")
    assert "Sub:" not in tokens and tokens == "Main: start.Main: done."
    skill_result = next(e for e in events if e["type"] == "tool.result" and "agent" not in e and "REPORT" in e["output"])
    assert "no TODO found" in skill_result["output"]
    assert [e["type"] for e in events].count("turn.end") == 1


# -- the protocol ----------------------------------------------------------------------------


def test_slash_menu_and_skill_commands(daemon, project, project_skills, fake_model):  # noqa: F811
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "skills.list"})
    items = c.until("skills")[0]["items"]
    names = [i["name"] for i in items]
    assert names[:len(names) - 3] == ["clear", "compact", "model", "skills", "cookbook", "servers", "preview", "help"]
    assert names[-3:] == ["greet", "research", "secret"]  # Not "hidden" (user-invocable false). Not the "help" skill.
    greet = next(i for i in items if i["name"] == "greet")
    assert greet["source"] == "project (.harness)" and greet["builtin"] is False

    fake_model.script({"text": "Hello, Grace."})
    c.send({"type": "command", "name": "greet", "args": "Grace"})
    c.until("turn.end")
    sent = fake_model.requests[-1]["messages"][-1]
    assert sent["role"] == "user" and "Say hello to Grace." in sent["content"] and "display" not in sent

    c.send({"type": "command", "name": "hidden", "args": ""})
    assert "for the model only" in c.until("error")[0]["message"]

    c.send({"type": "command", "name": "help", "args": ""})
    assert "/clear" in c.until("command.result")[0]["text"]  # The built-in command wins.

    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    history = c.until("session.ready")[0]["history"]
    assert history[0]["display"] == "/greet Grace"
    c.close()


def test_forked_skill_from_a_command(daemon, project, project_skills, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    fake_model.script({"text": "REPORT: done."})
    c.send({"type": "command", "name": "research", "args": "bugs"})
    end, seen = c.until("turn.end")
    assert end["stop_reason"] == "end"
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "REPORT: done."
    c.close()


def test_skills_panel_messages(daemon, project, project_skills, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "command", "name": "skills", "args": ""})
    result = c.until("command.result")[0]
    assert result["action"] == "open_panel" and result["panel"] == "skills"
    assert {i["name"] for i in result["items"]} == {"greet", "hidden", "help", "research", "secret"}
    c.send({"type": "skills.get", "name": "greet"})
    skill = c.until("skill")[0]
    assert skill["files"] == ["SKILL.md", "notes.md"] and "Say hello to $0." in skill["content"]
    assert skill["allowed-tools"] == ["Bash(echo hi)"]
    c.close()
