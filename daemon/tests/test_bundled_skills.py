"""The skills that come with Harness (harness_daemon/builtin_skills)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import harness_daemon.skills as skills_module
from harness_daemon.prompt import MAX_SKILL_DESCRIPTION
from harness_daemon.skills import PLACEHOLDER_RE, discover_skills, render_skill

REAL_DIR = Path(skills_module.__file__).parent / "builtin_skills"
NAMES = {
    "docx", "xlsx", "pptx", "pdf",  # Documents
    "init", "run", "debug", "code-review", "security-review", "simplify",  # Work on code
    "skill-creator", "mcp-builder",  # Anthropic skills under the Apache License 2.0, changed for Harness
}
APACHE = {"skill-creator", "mcp-builder"}


@pytest.fixture
def bundled(monkeypatch, tmp_path):
    monkeypatch.setattr(skills_module, "BUNDLED_SKILLS_DIR", REAL_DIR)
    monkeypatch.setenv("HARNESS_HOME", str(tmp_path / "harness-home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    project = tmp_path / "project"
    project.mkdir()
    return project


def test_the_bundled_skills_load(bundled):
    found = discover_skills(bundled)
    assert NAMES <= set(found)
    assert "_office" not in found  # The shared scripts folder has no SKILL.md.
    for name in NAMES:
        skill = found[name]
        assert skill.bundled
        assert skill.source_label == "built-in (Harness)"
        assert skill.summary()["bundled"] is True
        assert skill.model_invocable and skill.user_invocable


def test_the_descriptions_fit_in_the_system_prompt(bundled):
    # The system prompt cuts a description at MAX_SKILL_DESCRIPTION characters.
    for name, skill in discover_skills(bundled).items():
        if name in NAMES:
            assert len(skill.description) <= MAX_SKILL_DESCRIPTION, name


def test_the_bodies_have_no_positional_placeholders(bundled):
    # A "$1" in a body becomes an argument of the user. Absolute cell references such as "$B$2" must
    # be in the reference files, which the daemon does not change. "$ARGUMENTS" is allowed on purpose.
    for name in NAMES:
        body = discover_skills(bundled)[name].body()
        others = [m.group(0) for m in PLACEHOLDER_RE.finditer(body)
                  if not m.group(0).startswith("${") and m.group(0) != "$ARGUMENTS"]
        assert others == [], f"{name}: {others}"


def test_the_apache_skills_keep_their_license_and_list_the_changes():
    for name in APACHE:
        folder = REAL_DIR / name
        assert "Apache License" in (folder / "LICENSE.txt").read_text(encoding="utf-8")
        assert (folder / "MODIFICATIONS.md").is_file()
        assert "changed for Harness" in (folder / "SKILL.md").read_text(encoding="utf-8")
    # The skill-creator scripts that need the claude command-line program are not here.
    scripts = REAL_DIR / "skill-creator" / "scripts"
    for removed in ("run_eval.py", "run_loop.py", "improve_description.py", "generate_report.py"):
        assert not (scripts / removed).exists()


def test_the_paths_in_the_bodies_exist(bundled):
    found = discover_skills(bundled)
    for name in NAMES:
        text = render_skill(found[name], "", bundled)
        assert "${CLAUDE_SKILL_DIR}" not in text
        skill_dir = str(found[name].dir)
        for m in re.finditer(re.escape(skill_dir) + r"[/\\]([\w./\\-]+\.(?:py|md))", text):
            path = (found[name].dir / m.group(1)).resolve()
            assert path.is_file(), f"{name}: {m.group(0)}"


def test_an_added_skill_replaces_a_bundled_skill(bundled, tmp_path):
    own = bundled / ".claude" / "skills" / "docx"
    own.mkdir(parents=True)
    (own / "SKILL.md").write_text("---\nname: docx\ndescription: My own Word skill.\n---\nBody\n", encoding="utf-8")
    skill = discover_skills(bundled)["docx"]
    assert not skill.bundled
    assert skill.description == "My own Word skill."


def test_the_scripts_compile():
    scripts = sorted(REAL_DIR.rglob("*.py"))
    assert len(scripts) >= 20
    for path in scripts:
        # compile() writes no .pyc file into the skill folders.
        compile(path.read_text(encoding="utf-8"), str(path), "exec")


def test_the_docx_scripts_make_tracked_changes_and_comments(tmp_path):
    docx = pytest.importorskip("docx")
    import json
    import subprocess
    import sys

    path = tmp_path / "a.docx"
    doc = docx.Document()
    doc.add_paragraph("The Seller delivers the goods in 30 days.")
    doc.add_paragraph("This clause is void.")
    doc.save(path)
    changes = tmp_path / "c.json"
    changes.write_text(json.dumps([
        {"find": "30", "replace": "45"},
        {"op": "delete_paragraph", "find": "This clause is void."},
    ]), encoding="utf-8")
    scripts = REAL_DIR / "docx" / "scripts"
    run = lambda *args: subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True)  # noqa: E731
    result = run(scripts / "redline.py", path, changes, "-o", tmp_path / "b.docx")
    assert result.returncode == 0, result.stderr
    comments = tmp_path / "m.json"
    comments.write_text(json.dumps([{"find": "Seller", "text": "Which seller?"}]), encoding="utf-8")
    result = run(scripts / "comment.py", tmp_path / "b.docx", comments, "-o", tmp_path / "c.docx")
    assert result.returncode == 0, result.stderr
    result = run(REAL_DIR / "_office" / "ooxml.py", "check", tmp_path / "c.docx")
    assert result.returncode == 0, result.stdout
    result = run(scripts / "accept_changes.py", tmp_path / "c.docx", "-o", tmp_path / "d.docx")
    assert result.returncode == 0, result.stderr
    texts = [p.text for p in docx.Document(str(tmp_path / "d.docx")).paragraphs]
    assert texts == ["The Seller delivers the goods in 45 days."]
    # A change that does not match saves nothing.
    changes.write_text(json.dumps([{"find": "not there", "replace": "x"}]), encoding="utf-8")
    result = run(scripts / "redline.py", path, changes, "-o", tmp_path / "e.docx")
    assert result.returncode == 1 and not (tmp_path / "e.docx").exists()


def test_unpack_and_pack_keep_the_text(tmp_path):
    docx = pytest.importorskip("docx")
    import subprocess
    import sys

    path = tmp_path / "a.docx"
    doc = docx.Document()
    doc.add_paragraph("Two  spaces and a trailing space ")
    doc.save(path)
    ooxml = REAL_DIR / "_office" / "ooxml.py"
    for args in (("unpack", path, tmp_path / "x"), ("pack", tmp_path / "x", tmp_path / "b.docx")):
        result = subprocess.run([sys.executable, str(ooxml), *map(str, args)], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
    assert "\n  " in (tmp_path / "x" / "word" / "document.xml").read_text(encoding="utf-8")
    assert docx.Document(str(tmp_path / "b.docx")).paragraphs[0].text == "Two  spaces and a trailing space "
