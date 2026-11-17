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
    "limit_tool_calls": True,
    # The verify command of the project (verify.py), for .harness/settings.json: tests, a type check, or a lint.
    # It runs when the agent ends a turn that changed files. None: no check.
    "verify_command": None,
    "verify_timeout": 300,  # Seconds.
    # The time budget of a turn, in minutes. 0: no budget. The time that waits for the user does not count.
    "max_turn_minutes": 0,  # False: no tool call limit. A turn ends only when the model stops, or the user stops it.
    "bash_timeout": 120,
    "bash_max_timeout": 600,
    "max_output_chars": 20000,
    # edit and write reject a change to a file that the agent did not read, or that changed after the read.
    "read_before_edit": True,
    # The tool that changes files: "edit" (edit and write), "apply_patch" (one patch tool in their place), or
    # "auto" (apply_patch for the model families of tools/apply_patch.py APPLY_PATCH_FAMILIES).
    "edit_tool": "edit",
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
    "auto_review": False,  # A read-only subagent reviews a large change before the turn ends (verify.py).
    "auto_review_min_lines": 200,  # The changed lines of a turn that start the review.
    "image_input": None,  # True or False overrides the image input check of the model.
    "permission_mode": "default",  # default, acceptEdits, plan, auto, or bypassPermissions (permissions.py).
    # "Allow bypass permissions mode" (UI rule C12). Off: no session runs in bypassPermissions. User file only.
    "allow_bypass_permissions": False,
    "prompt_suggestions": True,  # After a turn, the model suggests the next prompt (suggestions.py).
    "subagents": True,  # The agent tool: the agent can start subagents, also several at once in the background.
    # Settings > Agents > "Update agents automatically": Harness downloads the new version of each enabled agent
    # that it downloaded, when the ACP registry or the GitHub release has one (server.py _auto_update_agents).
    "agents_auto_update": False,
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
# Keys that only ~/.harness/settings.json sets. A project file cannot change them: a repository must not turn the
# sandbox off (sandbox.py reads the user file only), or allow the bypass mode.
USER_ONLY_KEYS = ("sandbox", "allow_bypass_permissions")
BYPASS = "bypassPermissions"


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


# The permission mode of each project folder, outside the repository (change 4-D). A cloned repository can
# set "permission_mode" in its .harness/settings.json, but it cannot set bypassPermissions, and the mode that
# the user picks in the app has priority.
def mode_store_path() -> Path:
    return harness_home() / "permission_modes.json"


def _mode_key(cwd: Path) -> str:
    try:
        path = Path(cwd).resolve()
    except OSError:
        path = Path(cwd)
    return os.path.normcase(str(path))


def stored_mode(cwd: Path) -> str | None:
    """The mode that the user picked in the app for this folder, or None."""
    try:
        data = read_json(mode_store_path(), {})
    except ConfigError:
        return None
    value = data.get(_mode_key(cwd)) if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def store_mode(cwd: Path, mode: str) -> None:
    """Save the mode of a folder in the store of the user. The project settings file does not change."""
    try:
        data = read_json(mode_store_path(), {})
    except ConfigError:
        data = {}
    data = data if isinstance(data, dict) else {}
    data[_mode_key(cwd)] = mode
    write_json(mode_store_path(), data)


def bypass_allowed(settings: dict[str, Any] | None = None) -> bool:
    """The switch "Allow bypass permissions mode". Only the user settings file sets it."""
    if settings is None:
        try:
            settings = read_json(harness_home() / "settings.json", {})
        except ConfigError:
            return False
    return (settings or {}).get("allow_bypass_permissions") is True


def load_settings(cwd: Path | None = None) -> dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    settings.update(read_json(harness_home() / "settings.json", {}))
    allowed = bypass_allowed(settings)
    if cwd is not None:
        project = read_json(project_settings_path(cwd), {})
        settings.update({k: v for k, v in project.items() if k not in RULE_KEYS and k not in USER_ONLY_KEYS
                         and not (k == "permission_mode" and v == BYPASS)})  # A repository cannot set bypass.
        mode = stored_mode(cwd)
        if mode is not None:
            settings["permission_mode"] = mode
    if settings.get("permission_mode") == BYPASS and not allowed:
        settings["permission_mode"] = "default"
    return settings
