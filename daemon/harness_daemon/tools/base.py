"""Tool base classes."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..files import PathError, resolve_in_cwd
from .shell import ShellInfo


class ToolError(Exception):
    """A tool failure. The message goes to the model as an error result."""


@dataclass
class ToolContext:
    cwd: Path
    settings: dict[str, Any]
    shell: ShellInfo
    # Folders outside the project that the read-only tools can read: the skill folders.
    read_roots: tuple[Path, ...] = ()

    def resolve(self, path: Any, read_only: bool = False) -> Path:
        try:
            roots = self.read_roots if read_only else ()
            return resolve_in_cwd(self.cwd, path if isinstance(path, str) else "", roots)
        except PathError as e:
            raise ToolError(str(e)) from e


@dataclass
class ToolResult:
    output: str
    is_error: bool = False
    changed_paths: list[Path] = field(default_factory=list)
    diff: str | None = None  # A unified diff of a file change, for the client.


@dataclass
class Approval:
    """What the permission gate needs for one tool call.

    ``key`` is the value that permission rules match: a command or a path.
    ``rule`` is the rule that ``allow_always`` adds to the project settings.
    """

    key: str
    rule: str
    diff: str | None = None


class Tool:
    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {"type": "object", "properties": {}}
    needs_approval: bool = False

    def describe(self, ctx: ToolContext) -> str:
        return self.description

    def schema(self, ctx: ToolContext) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.describe(ctx),
                "parameters": self.parameters,
            },
        }

    def validate(self, args: dict[str, Any]) -> None:
        missing = [k for k in self.parameters.get("required", []) if args.get(k) is None]
        if missing:
            raise ToolError(f"Missing required argument: {', '.join(missing)}")

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        """Check the arguments before the permission gate.

        Return an Approval for a tool that needs approval. Raise ToolError for bad
        arguments, so that the user does not see a request that cannot succeed.
        """
        return None

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        raise NotImplementedError


def get_int(args: dict[str, Any], key: str, default: int | None) -> int | None:
    value = args.get(key)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ToolError(f"Argument '{key}' must be an integer.") from None


def get_bool(args: dict[str, Any], key: str, default: bool = False) -> bool:
    value = args.get(key)
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def truncate(text: str, limit: int, keep_tail: bool = False) -> str:
    if len(text) <= limit:
        return text
    removed = len(text) - limit
    if keep_tail:
        half = limit // 2
        body = text[:half] + "\n\n[...]\n\n" + text[-half:]
        where = "from the middle"
    else:
        body = text[:limit]
        where = "from the end"
    return (
        f"{body}\n\n[Output truncated. The full output has {len(text)} characters. "
        f"{removed} characters were removed {where}.]"
    )
