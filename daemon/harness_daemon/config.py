"""Paths and settings.

Global settings live in ``~/.harness/settings.json``. Project settings live in
``<project>/.harness/settings.json``. Project values override global values.
The ``HARNESS_HOME`` environment variable replaces ``~/.harness`` (used by tests).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DEFAULT_SETTINGS: dict[str, Any] = {
    "max_tool_calls": 250,
    "limit_tool_calls": True,  # False: no tool call limit. A turn ends only when the model stops, or the user stops it.
    "bash_timeout": 120,
    "bash_max_timeout": 600,
    "max_output_chars": 20000,
    # edit and write reject a change to a file that the agent did not read, or that changed after the read.
    "read_before_edit": True,
    # The task list reminders (update_plan): "auto" (by the scaffold tier of the model), "on", or "off".
    "task_reminders": "auto",
    "shell": None,
    "default_model": None,
    # The model by network (Settings > Providers). On: a new session with no model uses online_model when
    # its provider answers, else offline_model (a local model). Off: the model choice is manual.
    "auto_model": False,
    "online_model": None,
    "offline_model": None,
    "auto_verify": False,  # The agent checks the app with the preview tools after each UI change.
    "image_input": None,  # True or False overrides the image input check of the model.
    "permission_mode": "default",  # default, acceptEdits, plan, auto, or bypassPermissions (permissions.py).
    "prompt_suggestions": True,  # After a turn, the model suggests the next prompt (suggestions.py).
    "subagents": True,  # The agent tool: the agent can start subagents, also several at once in the background.
    # The global instructions of the user (Settings > Your Harness). The system prompt includes them (prompt.py).
    "auto_memory": True,  # The agent keeps notes between sessions (memory.py).
    "memory_sensitive": False,  # The memory can have sensitive topics, for example health conditions.
    "chat_search": True,  # The conversation_search tool: the agent searches the past sessions of the project.
    "web_search": "duckduckgo",  # The search provider of web_search (web.py): duckduckgo, brave, tavily, searxng, or off.
    "web_search_url": None,  # The URL of a SearXNG server, for "searxng".
    "time_format": "12h",  # "12h" (9:05 AM) or "24h" (09:05): the times of the app and the routine run titles.
    "output_style": "default",  # The output style of the agent (output_styles.py): a built-in id or a custom style file.
    "instructions_thinking": None,
    "instructions_research": None,
    "instructions_speaking": None,
    "instructions_other": None,
}

# Keys in the project settings file that are permission rules, not settings.
RULE_KEYS = ("allow", "deny")


class ConfigError(Exception):
    pass


def harness_home() -> Path:
    return Path(os.environ.get("HARNESS_HOME") or Path.home() / ".harness")


def project_settings_path(cwd: Path) -> Path:
    return Path(cwd) / ".harness" / "settings.json"


def read_json(path: Path, default: Any) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default
    if not text.strip():
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path} is not valid JSON: {e}") from e


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_settings(cwd: Path | None = None) -> dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    settings.update(read_json(harness_home() / "settings.json", {}))
    if cwd is not None:
        project = read_json(project_settings_path(cwd), {})
        settings.update({k: v for k, v in project.items() if k not in RULE_KEYS})
    return settings
