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
    "skill-creator", "mcp-builder",  # Make skills and MCP servers
}
# Anthropic skills under the Apache License 2.0, changed for Harness. The others are new work.
APACHE = {"docx", "xlsx", "pptx", "pdf", "skill-creator", "mcp-builder"}
OFFICE = ("docx", "pptx", "xlsx")  # Each has the same scripts/office folder.


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


def run_script(*args):
    # As the bash tool runs them: Python writes UTF-8 (tools/shell.py).
    import os
    import subprocess
    import sys

    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True,
                          encoding="utf-8", env=env)


def test_the_office_folders_are_the_same():
    # The original skills have three copies of scripts/office. The Harness changes go in all three.
    first = REAL_DIR / OFFICE[0] / "scripts" / "office"
    files = sorted(p.relative_to(first) for p in first.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    assert (first / "pack.py").is_file()
    for name in OFFICE[1:]:
        other = REAL_DIR / name / "scripts" / "office"
        assert sorted(p.relative_to(other) for p in other.rglob("*")
                      if p.is_file() and "__pycache__" not in p.parts) == files, name
        for rel in files:
            assert (other / rel).read_bytes() == (first / rel).read_bytes(), f"{name}: {rel}"


def test_soffice_needs_no_af_unix(monkeypatch):
    # Windows Python has no socket.AF_UNIX. The helper must not fail there.
    import importlib.util
    import os
    import socket

    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))  # The import can add the LibreOffice folder.
    path = REAL_DIR / "docx" / "scripts" / "office" / "soffice.py"
    spec = importlib.util.spec_from_file_location("harness_test_soffice", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.delattr(socket, "AF_UNIX", raising=False)
    assert module._needs_shim() is False


def test_pack_makes_a_file_without_folder_entries(tmp_path):
    docx = pytest.importorskip("docx")
    import zipfile

    path = tmp_path / "a.docx"
    doc = docx.Document()
    doc.add_paragraph("Two  spaces and a trailing space ")
    doc.save(path)
    zipfile.ZipFile(path).extractall(tmp_path / "x")
    (tmp_path / "b.docx").write_bytes(b"old file")  # pack.py replaces an old output.
    result = run_script(REAL_DIR / "docx" / "scripts" / "office" / "pack.py", tmp_path / "x", tmp_path / "b.docx")
    assert result.returncode == 0, result.stderr
    names = zipfile.ZipFile(tmp_path / "b.docx").namelist()
    assert names[0] == "[Content_Types].xml"
    assert not any(n.endswith("/") for n in names)
    assert docx.Document(str(tmp_path / "b.docx")).paragraphs[0].text == "Two  spaces and a trailing space "


def test_the_docx_scripts_merge_runs_add_a_comment_and_validate(tmp_path):
    docx = pytest.importorskip("docx")
    pytest.importorskip("defusedxml")
    pytest.importorskip("lxml")

    path = tmp_path / "a.docx"
    doc = docx.Document()
    p = doc.add_paragraph()
    p.add_run("The Seller ")
    p.add_run("delivers the goods.")
    doc.save(path)
    scripts = REAL_DIR / "docx" / "scripts"
    result = run_script(scripts / "merge_runs.py", path, "-o", tmp_path / "m.docx")
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(docx.Document(str(tmp_path / "m.docx")).paragraphs[0].runs) == 1
    result = run_script(scripts / "comment.py", tmp_path / "m.docx", "Which seller?", "-o", tmp_path / "c.docx")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "commentReference" in result.stdout  # It prints the markers for document.xml.
    result = run_script(scripts / "office" / "validate.py", tmp_path / "c.docx", "--original", path)
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_pptx_slide_text_reads_a_deck(tmp_path):
    pptx = pytest.importorskip("pptx")

    deck = pptx.Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = "Quarterly results"
    slide.placeholders[1].text = "Revenue grew"
    deck.save(tmp_path / "d.pptx")
    result = run_script(REAL_DIR / "pptx" / "scripts" / "slide_text.py", tmp_path / "d.pptx")
    assert result.returncode == 0, result.stderr
    assert "<!-- Slide number: 1 -->" in result.stdout
    assert "Quarterly results" in result.stdout and "Revenue grew" in result.stdout
