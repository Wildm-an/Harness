"""Tests for send_file and artifact (tools/share.py), the artifact pages of the daemon, and the
previews and notes of ask_user_question (tools/interact.py)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import ArtifactTool, SendFileTool, ToolContext, ToolError, detect_shell
from harness_daemon.tools.interact import _clean_questions
from harness_daemon.tools.share import artifact_page, list_artifacts

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

PAGE = "<!doctype html><html><head><title>Sales  report</title></head><body><h1>Q3</h1></body></html>"


@pytest.fixture
def ctx(project, harness_home):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def run(tool, ctx, **args):
    asyncio.run(tool.prepare(args, ctx))
    return asyncio.run(tool.run(args, ctx))


def test_send_file_gives_a_card_with_the_files(ctx, project):
    (project / "out").mkdir()
    (project / "out" / "report.csv").write_bytes(b"a,b\n1,2\n")
    result = run(SendFileTool(), ctx, files=["out/report.csv", "hello.py"], caption="The  numbers",
                 display="attach", status="proactive")
    assert not result.is_error and "out/report.csv, hello.py" in result.output
    card = result.card
    assert (card["type"], card["caption"], card["display"], card["status"]) == ("files", "The numbers", "attach", "proactive")
    first = card["files"][0]
    assert (first["path"], first["name"], first["size"], first["project"]) == ("out/report.csv", "report.csv", 8, True)
    assert first["abs"].endswith("report.csv")
    # No display: the app decides. A bad status is "normal".
    card = run(SendFileTool(), ctx, files=["hello.py"], status="loud").card
    assert (card["display"], card["status"]) == ("auto", "normal")


def test_send_file_refuses_missing_and_outside_files(ctx, tmp_path):
    with pytest.raises(ToolError, match="does not exist"):
        run(SendFileTool(), ctx, files=["nope.txt"])
    with pytest.raises(ToolError):
        run(SendFileTool(), ctx, files=[str(tmp_path / "elsewhere.txt")])
    with pytest.raises(ToolError, match="1 to 10"):
        run(SendFileTool(), ctx, files=[])


def test_publish_update_list_read_and_delete_an_artifact(ctx, project):
    (project / "report.html").write_text(PAGE)
    tool = ArtifactTool()
    first = run(tool, ctx, file_path="report.html", description="The sales of Q3.")
    card = first.card
    assert (card["type"], card["title"], card["description"], card["version"]) == ("artifact", "Sales report", "The sales of Q3.", 1)
    assert artifact_page(card["id"]).read_text() == PAGE

    # The same file again: the same artifact, a new version. The description stays.
    (project / "report.html").write_text(PAGE.replace("Q3", "Q4"))
    second = run(tool, ctx, file_path="report.html", title="Q4 sales")
    assert (second.card["id"], second.card["version"], second.card["title"]) == (card["id"], 2, "Q4 sales")
    assert second.card["description"] == "The sales of Q3."
    assert "Q4" in artifact_page(card["id"]).read_text()
    assert [m["id"] for m in list_artifacts()] == [card["id"]]

    assert card["id"] in run(tool, ctx, action="list").output
    assert "<h1>Q4</h1>" in run(tool, ctx, action="read", id=card["id"]).output

    # Delete asks first. The other actions do not.
    assert asyncio.run(tool.prepare({"action": "delete", "id": card["id"]}, ctx)).input["title"] == "Q4 sales"
    assert asyncio.run(tool.prepare({"action": "list"}, ctx)) is None
    run(tool, ctx, action="delete", id=card["id"])
    assert artifact_page(card["id"]) is None and list_artifacts() == []


def test_artifact_refuses_bad_input(ctx, project):
    tool = ArtifactTool()
    (project / "notes.md").write_text("# Notes")
    with pytest.raises(ToolError, match="HTML page"):
        run(tool, ctx, file_path="notes.md")
    with pytest.raises(ToolError, match="'id'"):
        run(tool, ctx, action="read", id="../../etc")
    with pytest.raises(ToolError, match="action"):
        run(tool, ctx, action="share")


def test_daemon_serves_an_artifact_page_in_a_sandbox(daemon, harness_home, project):  # noqa: F811
    (project / "page.html").write_text(PAGE)
    ctx = ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())
    artifact_id = run(ArtifactTool(), ctx, file_path="page.html").card["id"]
    base = daemon.replace("ws://", "http://").removesuffix("/ws")
    page = httpx.get(f"{base}/artifacts/{artifact_id}/")
    assert page.status_code == 200 and page.text == PAGE
    assert page.headers["content-security-policy"].startswith("sandbox allow-scripts")
    assert "allow-same-origin" not in page.headers["content-security-policy"]
    assert httpx.get(f"{base}/artifacts/unknown-id-1234/").status_code == 404


def test_question_options_keep_their_preview():
    questions = _clean_questions([{"question": "Which layout?", "header": "Layout", "options": [
        {"label": "Grid", "preview": "+--+--+\n|  |  |\n+--+--+\n\n"}, {"label": "List", "preview": "  "}]}])
    grid, plain = questions[0]["options"]
    assert grid["preview"] == "+--+--+\n|  |  |\n+--+--+" and "preview" not in plain
    with pytest.raises(ToolError, match="limit"):
        _clean_questions([{"question": "Which?", "header": "H", "options": [{"label": "A", "preview": "x" * 5000}, {"label": "B"}]}])


def test_the_notes_of_an_answer_go_to_the_agent(daemon, project, fake_model):  # noqa: F811
    question = {"question": "Which layout?", "header": "Layout",
                "options": [{"label": "Grid", "preview": "[] []"}, {"label": "List", "preview": "[]\n[]"}]}
    fake_model.script(
        {"tool_calls": [{"name": "ask_user_question", "arguments": {"questions": [question]}}]},
        {"text": "Grid it is."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "make the page"})
    request = c.until("permission.request")[0]
    assert request["questions"][0]["options"][1]["preview"] == "[]\n[]"
    c.send({"type": "question.reply", "request_id": request["request_id"], "answers": {"Which layout?": "Grid"},
            "notes": {"Which layout?": " three columns "}})
    c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")
    assert '"Which layout?" = "Grid" (the user added the note: "three columns")' in result["content"]
    c.close()
