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
    "max_tool_calls": 50,
    "bash_timeout": 120,
    "bash_max_timeout": 600,
    "max_output_chars": 20000,
    "shell": None,
    "default_model": None,
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
