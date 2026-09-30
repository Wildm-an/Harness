"""Skills in the Claude Code SKILL.md format (SPEC.md section 6).

A skill is a folder with a SKILL.md file: YAML frontmatter and a Markdown body.
The daemon reads only the frontmatter at session start. It reads the body when
the model calls the skill tool or the user types /skill-name.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import harness_home

log = logging.getLogger("harness.skills")

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
MAX_BODY_CHARS = 60_000
MAX_DESCRIPTION_CHARS = 1024


def claude_home() -> Path:
    """The Claude Code configuration folder. CLAUDE_CONFIG_DIR replaces ~/.claude."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    path: Path  # The SKILL.md file.
    source: str  # "user", "project", or "plugin"
    origin: str  # ".harness" or ".claude", or the plugin name for a plugin skill
    disable_model_invocation: bool = False
    user_invocable: bool = True
    allowed_tools: tuple[str, ...] = ()
    argument_hint: str = ""
    context: str | None = None  # "fork": run in a subagent with a new context.
    extra: dict[str, Any] = field(default_factory=dict, hash=False, compare=False)
    # A skill of a DeepSeek plugin has its text in memory and no SKILL.md file.
    content: str | None = field(default=None, hash=False, compare=False)
    resource_dir: Path | None = field(default=None, hash=False, compare=False)

    @property
    def dir(self) -> Path:
        if self.content is not None:
            return self.resource_dir or self.path.parent
        return self.path.parent

    @property
    def has_files(self) -> bool:
        """True if the skill is a folder on disk."""
        return self.content is None or self.resource_dir is not None

    @property
    def model_invocable(self) -> bool:
        return not self.disable_model_invocation

    @property
    def source_label(self) -> str:
        return f"{self.source} ({self.origin})"

    def body(self) -> str:
        if self.content is not None:
            return self.content.strip()[:MAX_BODY_CHARS]
        _, body = split_frontmatter(self.path.read_text(encoding="utf-8", errors="replace"))
        return body.strip()[:MAX_BODY_CHARS]

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "argument-hint": self.argument_hint,
            "source": self.source_label,
            "path": str(self.path),
            "user-invocable": self.user_invocable,
            "model-invocable": self.model_invocable,
            "context": self.context,
            "builtin": False,
        }


# -- parsing --------------------------------------------------------------------------


def split_frontmatter(text: str) -> tuple[str, str]:
    """Return the frontmatter text and the body. A file with no frontmatter has only a body."""
    text = text.lstrip("﻿")
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "".join(lines[1:i]), "".join(lines[i + 1:])
    return "", text


def parse_frontmatter(raw: str) -> dict[str, Any]:
    if not raw.strip():
        return {}
    try:
        data = yaml.safe_load(raw)
        if isinstance(data, dict):
            return data
    except yaml.YAMLError:
        pass
    # Some skills have YAML that is not strict, for example an unquoted ": " in a description.
    data: dict[str, Any] = {}
    for line in raw.splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() and not line.startswith((" ", "\t")):
            data[key.strip()] = value.strip().strip("\"'")
    return data


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1")
    return bool(value)


def _as_list(value: Any) -> tuple[str, ...]:
    """allowed-tools is a YAML list or a string such as "Bash(git add:*), Read"."""
    if value is None:
        return ()
    if isinstance(value, str):
        parts, depth, current = [], 0, ""
        for ch in value:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(depth - 1, 0)
            if ch in ", " and depth == 0:
                if current.strip():
                    parts.append(current.strip())
                current = ""
            else:
                current += ch
        if current.strip():
            parts.append(current.strip())
        return tuple(parts)
    if isinstance(value, list):
        return tuple(str(v).strip() for v in value if str(v).strip())
    return ()


def _first_paragraph(body: str) -> str:
    for block in re.split(r"\n\s*\n", body.strip()):
        text = " ".join(line.strip() for line in block.splitlines() if not line.lstrip().startswith("#"))
        if text:
            return text
    return ""


def load_skill(path: Path, source: str, origin: str) -> Skill | None:
    try:
        raw, body = split_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
    except OSError as e:
        log.warning("Cannot read %s: %s", path, e)
        return None
    meta = parse_frontmatter(raw)
    name = str(meta.get("name") or path.parent.name).strip()
    if not NAME_RE.match(name):
        log.warning("Skipping %s: the name %r is not valid.", path, name)
        return None
    description = " ".join(str(meta.get("description") or _first_paragraph(body)).split())
    context = meta.get("context")
    return Skill(
        name=name,
        description=description[:MAX_DESCRIPTION_CHARS],
        path=path,
        source=source,
        origin=origin,
        disable_model_invocation=_as_bool(meta.get("disable-model-invocation"), False),
        user_invocable=_as_bool(meta.get("user-invocable"), True),
        allowed_tools=_as_list(meta.get("allowed-tools")),
        argument_hint=str(meta.get("argument-hint") or "").strip(),
        context=str(context).strip() if context else None,
        extra={k: v for k, v in meta.items() if k not in KNOWN_FIELDS},
    )


KNOWN_FIELDS = {
    "name", "description", "disable-model-invocation", "user-invocable",
    "allowed-tools", "argument-hint", "context",
}


# -- discovery ----------------------------------------------------------------------


def skill_roots(cwd: Path | None, plugin_roots: list[tuple[Path, str]] | None = None) -> list[tuple[Path, str, str]]:
    """The skill folders, from the lowest to the highest priority.

    A project skill wins over a user skill, and a user skill wins over a plugin skill.
    In the same scope, .harness wins over .claude.
    """
    roots = [(path, "plugin", plugin) for path, plugin in plugin_roots or []]
    roots += [
        (claude_home() / "skills", "user", ".claude"),
        (harness_home() / "skills", "user", ".harness"),
    ]
    if cwd is not None:
        roots += [
            (Path(cwd) / ".claude" / "skills", "project", ".claude"),
            (Path(cwd) / ".harness" / "skills", "project", ".harness"),
        ]
    return roots


def discover_skills(cwd: Path | None, plugin_roots: list[tuple[Path, str]] | None = None,
                    plugin_skills: dict[str, Skill] | None = None) -> dict[str, Skill]:
    """The skills of all folders.

    ``plugin_roots``: the skill folders of the plugins, with the plugin names. ``plugin_skills``:
    the skills of DeepSeek plugins, which have no folder. A skill in a folder wins over them.
    """
    skills: dict[str, Skill] = dict(plugin_skills or {})
    seen: set[Path] = set()
    for root, source, origin in skill_roots(cwd, plugin_roots):
        if not root.is_dir():
            continue
        try:
            real_root = root.resolve()
        except OSError:
            continue
        if real_root in seen:  # For example, HARNESS_HOME points to the same folder.
            continue
        seen.add(real_root)
        for folder in sorted(p for p in root.iterdir() if p.is_dir()):
            skill_file = folder / "SKILL.md"
            if skill_file.is_file():
                skill = load_skill(skill_file, source, origin)
                if skill:
                    skills[skill.name] = skill
    return dict(sorted(skills.items(), key=lambda item: item[0].lower()))


# -- arguments --------------------------------------------------------------------------


def split_arguments(args: str) -> list[str]:
    try:
        return shlex.split(args, posix=True)
    except ValueError:  # An unclosed quote.
        return args.split()


PLACEHOLDER_RE = re.compile(
    r"\$\{(?:CLAUDE|HARNESS)_(SKILL|PROJECT)_DIR\}"  # 1: SKILL or PROJECT
    r"|\$ARGUMENTS\[(\d+)\]"  # 2: index
    r"|\$ARGUMENTS\b"
    r"|\$(\d+)(?!\d)"  # 3: index
)


def substitute(body: str, args: str, skill_dir: Path, project_dir: Path) -> str:
    """Replace the placeholders of SPEC.md section 6.2 in one pass.

    If the body has no argument placeholder and the user gave arguments, the arguments
    are added at the end, the same as in Claude Code.
    """
    positional = split_arguments(args)
    used_arguments = False

    def replace(m: re.Match[str]) -> str:
        nonlocal used_arguments
        if m.group(1):
            return str(skill_dir if m.group(1) == "SKILL" else project_dir)
        used_arguments = True
        index = m.group(2) or m.group(3)
        if index is not None:
            i = int(index)
            return positional[i] if i < len(positional) else ""
        return args

    result = PLACEHOLDER_RE.sub(replace, body)
    if args.strip() and not used_arguments:
        result = f"{result.rstrip()}\n\nARGUMENTS: {args.strip()}"
    return result


def render_skill(skill: Skill, args: str, project_dir: Path) -> str:
    """The skill text for the model: a header with the folder, then the body."""
    body = substitute(skill.body(), args, skill.dir, project_dir)
    if not skill.has_files:
        return body
    return (
        f"Base folder of the skill {skill.name}: {skill.dir}\n"
        "Read the reference files in this folder only when the instructions tell you to.\n\n"
        f"{body}"
    )
