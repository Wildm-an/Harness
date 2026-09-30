"""Tests for the write, glob, and grep tools, and the project instruction file."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.prompt import build_system_prompt, load_project_instructions
from harness_daemon.tools import GlobTool, GrepTool, ToolContext, ToolError, WriteTool, detect_shell
from harness_daemon.tools import search
from harness_daemon.tools.search import find_ripgrep, glob_match

RG = find_ripgrep()


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def tree(project):
    files = {
        "src/app.py": "import os\n\ndef main():\n    print('Hello')\n    return 0\n",
        "src/util/helpers.py": "def helper():\n    return 'hello world'\n",
        "src/web/index.ts": "export const greeting = 'HELLO';\n",
        "docs/guide.md": "# Guide\nSay hello.\n",
        "node_modules/pkg/index.js": "hello from a dependency\n",
    }
    for rel, text in files.items():
        path = project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())
    # Make the ages different, so that the newest-first order is known.
    now = time.time()
    for i, rel in enumerate(["docs/guide.md", "src/web/index.ts", "src/util/helpers.py", "src/app.py"]):
        os.utime(project / rel, (now - 100 + i, now - 100 + i))
    return project


def make_ctx(root, **settings):
    return ToolContext(cwd=root.resolve(), settings={**DEFAULT_SETTINGS, **settings}, shell=detect_shell())


@pytest.fixture(params=["python", "ripgrep"])
def ctx(request, tree):
    if request.param == "ripgrep":
        if not RG:
            pytest.skip("ripgrep is not installed")
        return make_ctx(tree, ripgrep=RG)
    # A path that does not exist turns ripgrep off.
    return make_ctx(tree, ripgrep="no-such-ripgrep-binary")


# -- write ---------------------------------------------------------------------


def test_write_creates_a_file_with_folders(tree):
    ctx = make_ctx(tree)
    tool = WriteTool()
    args = {"path": "new/deep/file.txt", "content": "one\ntwo\n"}
    approval = run(tool.prepare(args, ctx))
    assert approval.rule == "write(new/deep/file.txt)"
    assert approval.diff.startswith("--- /dev/null\n+++ b/new/deep/file.txt")
    result = run(tool.run(args, ctx))
    assert result.output == "Created new/deep/file.txt (2 lines)."
    assert (tree / "new/deep/file.txt").read_bytes() == b"one\ntwo\n"


def test_write_replaces_and_keeps_crlf(tree):
    ctx = make_ctx(tree)
    (tree / "win.txt").write_bytes(b"a\r\nb\r\n")
    result = run(WriteTool().run({"path": "win.txt", "content": "x\ny\n"}, ctx))
    assert result.output.startswith("Replaced the content of win.txt")
    assert (tree / "win.txt").read_bytes() == b"x\r\ny\r\n"
    assert "-a" in result.diff and "+x" in result.diff


def test_write_rejects_folders_and_outside_paths(tree):
    ctx = make_ctx(tree)
    with pytest.raises(ToolError, match="folder"):
        run(WriteTool().prepare({"path": "src", "content": ""}, ctx))
    with pytest.raises(ToolError, match="outside"):
        run(WriteTool().prepare({"path": "../x.txt", "content": ""}, ctx))


# -- glob ----------------------------------------------------------------------


@pytest.mark.parametrize("path,pattern,expected", [
    ("src/a.py", "*.py", True),
    ("src/a/b.py", "src/*.py", False),
    ("src/a/b.py", "src/**/*.py", True),
    ("src/b.py", "src/**/*.py", True),
    ("x/y.tsx", "**/*.{ts,tsx}", True),
    ("README.md", "./README.md", True),
    (".github/ci.yml", "./.github/*.yml", True),
])
def test_glob_match(path, pattern, expected):
    assert glob_match(path, pattern) is expected


def test_glob_lists_newest_first_and_skips_dependencies(ctx):
    out = run(GlobTool().run({"pattern": "**/*.py"}, ctx)).output.splitlines()
    # hello.py comes from the project fixture. It is the newest file.
    assert out == ["hello.py", "src/app.py", "src/util/helpers.py"]
    assert "No files match" in run(GlobTool().run({"pattern": "*.rs"}, ctx)).output


def test_glob_in_a_subfolder(ctx):
    out = run(GlobTool().run({"pattern": "*", "path": "src/util"}, ctx)).output
    assert out == "src/util/helpers.py"


def test_slow_ripgrep_gives_a_tool_error(tree, monkeypatch):
    def slow(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], search.SEARCH_TIMEOUT)
    monkeypatch.setattr(search.subprocess, "run", slow)
    with pytest.raises(ToolError, match="stopped after 30 seconds"):
        run(GlobTool().run({"pattern": "**/*.py"}, make_ctx(tree, ripgrep=sys.executable)))
    with pytest.raises(ToolError, match="stopped after 30 seconds"):
        run(GrepTool().run({"pattern": "hello"}, make_ctx(tree, ripgrep=sys.executable)))


def test_slow_python_walk_gives_a_tool_error(tree):
    with pytest.raises(ToolError, match="stopped after 0 seconds"):
        list(search.walk_files(tree, timeout=0))


# -- grep ----------------------------------------------------------------------


def test_grep_lists_files(ctx):
    out = run(GrepTool().run({"pattern": "hello"}, ctx)).output.splitlines()
    # Case matters. node_modules is skipped.
    assert sorted(out) == ["docs/guide.md", "hello.py", "src/util/helpers.py"]


def test_grep_ignore_case_and_glob(ctx):
    out = run(GrepTool().run({"pattern": "hello", "ignore_case": True, "glob": "*.{py,ts}"}, ctx)).output
    assert sorted(out.splitlines()) == ["hello.py", "src/app.py", "src/util/helpers.py", "src/web/index.ts"]


def test_grep_content_with_context(ctx):
    out = run(GrepTool().run({"pattern": "print", "output": "content", "context": 1, "path": "src/app.py"}, ctx)).output
    assert out.splitlines() == [
        "src/app.py-3-def main():",
        "src/app.py:4:    print('Hello')",
        "src/app.py-5-    return 0",
    ]


def test_grep_count(ctx):
    out = run(GrepTool().run({"pattern": "e", "output": "count", "path": "docs"}, ctx)).output
    assert out == "docs/guide.md:2"


def test_grep_bad_pattern(ctx):
    with pytest.raises(ToolError):
        run(GrepTool().run({"pattern": "(unclosed"}, ctx))


def test_grep_no_match(ctx):
    assert "No matches" in run(GrepTool().run({"pattern": "zzz_not_here"}, ctx)).output


# -- project instructions -----------------------------------------------------------


def test_harness_md_has_priority_over_claude_md(project):
    assert load_project_instructions(project) is None
    (project / "CLAUDE.md").write_text("Use tabs.")
    assert load_project_instructions(project).name == "CLAUDE.md"
    (project / "HARNESS.md").write_text("Use spaces.")
    found = load_project_instructions(project)
    assert (found.name, found.text) == ("HARNESS.md", "Use spaces.")
    prompt = build_system_prompt(make_ctx(project), "fake/m", found, summary="Earlier work.")
    assert "HARNESS.md" in prompt and "Use spaces." in prompt and "Use tabs." not in prompt
    assert "# Summary of the earlier conversation" in prompt and "Earlier work." in prompt
