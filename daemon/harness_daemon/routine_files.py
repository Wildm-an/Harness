"""Routines as files: one Markdown file for each routine in ``~/.harness/routines/``.

The file name (with no ``.md``) is the id of the routine. The frontmatter has the settings, and the
body is the prompt::

    ---
    name: Daily summary
    schedule: 0 9 * * 1-5
    cwd: C:\\Users\\me\\project
    model: ollama/qwen3
    permission_mode: default
    enabled: true
    time_in_title: true
    ---
    Summarize the commits of the last day.

The user can read, edit, copy, and back up the files. A file that the user adds by hand is a new
routine. The run history and the scheduler state stay in the database (storage.py).
"""

from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path
from typing import Any

import yaml

from .cron import CronError, parse_cron

MODES = ("default", "acceptEdits", "plan", "auto", "bypassPermissions")
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
SUFFIX = ".md"


def valid_id(routine_id: str) -> bool:
    """A routine id is a plain file name: it cannot point outside the folder."""
    return bool(ID_PATTERN.match(routine_id or ""))


def slug(name: str) -> str:
    """A file name for a routine name: "Daily summary" -> "daily-summary"."""
    text = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].strip("-")
    return text or "routine"


def _split(text: str) -> tuple[str, str]:
    text = text.lstrip("\ufeff")
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "".join(lines[1:i]), "".join(lines[i + 1:])
    return "", text


def read(path: Path) -> dict[str, Any]:
    """The routine of a file. A file with a problem gets an "error" text, and the scheduler skips it."""
    item: dict[str, Any] = {"id": path.stem, "name": path.stem, "prompt": "", "cwd": "", "provider": None,
                            "model": None, "permission_mode": "default", "schedule": "", "enabled": False,
                            "time_in_title": True, "error": None}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        item["error"] = f"The file cannot be read: {e}"
        return item
    raw, body = _split(text)
    try:
        data = yaml.safe_load(raw) if raw.strip() else {}
    except yaml.YAMLError as e:
        item["error"] = f"The frontmatter is not valid YAML: {str(e).splitlines()[0]}"
        return item
    if not isinstance(data, dict):
        item["error"] = "The file has no frontmatter. Put the settings between two lines of ---."
        return item
    item.update(
        name=str(data.get("name") or path.stem).strip(),
        prompt=body.strip(),
        cwd=str(data.get("cwd") or "").strip(),
        model=str(data["model"]).strip() if data.get("model") else None,
        permission_mode=str(data.get("permission_mode") or "default"),
        schedule=" ".join(str(data.get("schedule") or "").split()),
        enabled=data.get("enabled", True) is not False,
        time_in_title=data.get("time_in_title", True) is not False,
    )
    item["error"] = problem(item)
    if item["error"]:
        item["enabled"] = False
    return item


def problem(item: dict[str, Any]) -> str | None:
    """What is wrong with the fields of a routine, or None."""
    if not item["prompt"]:
        return "The file has no prompt. Write the prompt under the frontmatter."
    if not item["cwd"]:
        return "The frontmatter has no cwd (the project folder)."
    if item["permission_mode"] not in MODES:
        return f"permission_mode must be one of: {', '.join(MODES)}."
    try:
        parse_cron(item["schedule"])
    except CronError as e:
        return f"schedule: {e}"
    return None


def render(item: dict[str, Any]) -> str:
    """The text of the file of a routine."""
    front: dict[str, Any] = {"name": item["name"], "schedule": item["schedule"], "cwd": item["cwd"]}
    if item.get("model"):
        front["model"] = item["model"]
    front["permission_mode"] = item.get("permission_mode") or "default"
    front["enabled"] = bool(item.get("enabled", True))
    front["time_in_title"] = item.get("time_in_title", True) is not False
    head = yaml.safe_dump(front, sort_keys=False, allow_unicode=True, width=1000)
    return f"---\n{head}---\n{item['prompt'].strip()}\n"


def run_title(item: dict[str, Any], when: dt.datetime, time_format: Any = "12h") -> str:
    """The title of the session of a run: "Daily summary - (09:00 AM) 11/13/26", or only the name when
    ``time_in_title`` is off. The time is the start of the run, in local time. ``time_format`` is the
    user setting (Settings > General > "Time format"): "24h" gives "(09:00)", all other values 12-hour time."""
    if item.get("time_in_title", True) is False:
        return item["name"]
    if time_format == "24h":
        clock = f"{when:%H:%M}"
    else:  # %p depends on the locale: AM and PM are always in English, as in the app.
        clock = f"{when:%I:%M} {'AM' if when.hour < 12 else 'PM'}"
    return f"{item['name']} - ({clock}) {when:%m/%d/%y}"


def write(path: Path, item: dict[str, Any]) -> None:
    """Write the file in one step: a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(render(item), encoding="utf-8")
    os.replace(temp, path)
