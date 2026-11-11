"""Output styles (output_styles.py): the built-in styles, the custom style files, the prompt, and "New output style"."""

from __future__ import annotations

from harness_daemon import output_styles
from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.prompt import build_system_prompt
from harness_daemon.tools import ToolContext, detect_shell

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def make_ctx(root, **settings):
    return ToolContext(cwd=root.resolve(), settings={**DEFAULT_SETTINGS, **settings}, shell=detect_shell())


def test_the_style_goes_into_the_prompt_of_the_session_agent(harness_home, project):
    assert "# Output style" not in build_system_prompt(make_ctx(project), "fake/m")
    ctx = make_ctx(project, output_style="concise")
    prompt = build_system_prompt(ctx, "fake/m")
    assert "# Output style: Concise" in prompt and "Lead with the result" in prompt
    assert "# Output style" not in build_system_prompt(ctx, "fake/m", user_facing=False)  # Not a subagent.
    assert "# Output style" not in build_system_prompt(make_ctx(project, output_style="gone"), "fake/m")


def test_custom_style_files(harness_home):
    assert [s.id for s in output_styles.all_styles()] == ["default", "concise", "explanatory", "learning", "proactive"]
    first = output_styles.save("Short answers", "Short answers first.", "Give the answer first.")
    second = output_styles.save("Short answers", "Again.", "Again.")
    assert (first.id, second.id) == ("short-answers", "short-answers-2")
    assert output_styles.find("short-answers").prompt == "Give the answer first."
    assert output_styles.find("../settings") is None
    (output_styles.styles_dir() / "concise.md").write_text("---\nname: Not built in\n---\nNo.", encoding="utf-8")
    assert output_styles.find("concise").name == "Concise"  # A file cannot replace a built-in style.
    assert output_styles.prompt_section("short-answers").startswith("# Output style: Short answers")


def test_parse_a_draft():
    assert output_styles.parse_draft("Name: Brief\n\n- Answer first.") == ("Brief", "- Answer first.")
    assert output_styles.parse_draft("<think>hmm</think>**Name:** \"Calm\"\n- Be calm.") == ("Calm", "- Be calm.")
    assert output_styles.parse_draft("- Only rules.") == (None, "- Only rules.")


def test_new_output_style_and_the_setting(daemon, harness_home, project, fake_model):
    fake_model.script({"text": "Name: Brief first\n\n- Give the short answer first.\n- Then the detail."},
                      {"text": "OK."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "output_styles.list"})
    got = c.until("output_styles")[0]
    assert [i["id"] for i in got["items"]][:2] == ["default", "concise"] and got["folder"].endswith("output-styles")
    c.send({"type": "user_settings.set", "values": {"output_style": "nope"}})
    assert "Unknown output style" in c.until("error")[0]["message"]
    c.send({"type": "output_styles.create", "description": "Short answers first, then detail.", "name": ""})
    got = c.until("output_styles")[0]
    assert got["created"] == "brief-first" and got["note"] is None
    assert {"id": "brief-first", "name": "Brief first", "description": "Short answers first, then detail.",
            "custom": True} in got["items"]
    assert c.until("user_settings")[0]["values"]["output_style"] == "brief-first"
    # The open session uses the new style at the next turn.
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    system = fake_model.requests[-1]["messages"][0]["content"]
    assert "# Output style: Brief first" in system and "- Give the short answer first." in system
    c.send({"type": "output_styles.create", "description": "   "})
    assert "Describe the style" in c.until("error")[0]["message"]
    c.send({"type": "user_settings.set", "values": {"output_style": "default"}})
    assert c.until("user_settings")[0]["values"]["output_style"] == "default"
    c.close()
