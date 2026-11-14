"""Tool base classes."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..files import PathError, resolve_in_cwd
from .shell import ShellInfo


class ToolError(Exception):
    """A tool failure. The message goes to the model as an error result."""


NOT_READ = ("You did not read {path} in this session. Read it with the read tool, then send this edit again. "
            "The harness needs the read, so that your edit uses the current text of the file.")
NOT_READ_WRITE = ("{path} exists, and you did not read it in this session. Read it with the read tool before you "
                  "replace it, so that you do not remove content that you did not see. To change part of the file, "
                  "use edit.")
CHANGED_SINCE_READ = ("{path} changed after you read it. Read it again, then send this edit again. Your copy of the "
                      "text is old.")


@dataclass
class ReadState:
    """The files that the agent read or wrote in this session, with a hash of the bytes that it saw.

    edit and write check it: a change to a file that the agent did not read, or that changed on disk after the
    read, is rejected with an error that states the fix. A partial read (offset and limit) counts: the exact
    match of edit proves that the agent saw the text that it replaces.
    """

    files: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def _key(path: Path) -> str:
        return os.path.normcase(str(path.resolve()))

    def note(self, path: Path, data: bytes) -> None:
        self.files[self._key(path)] = hashlib.sha256(data).hexdigest()

    def check(self, path: Path, data: bytes, shown: str, replace: bool = False) -> None:
        seen = self.files.get(self._key(path))
        if seen is None:
            raise ToolError((NOT_READ_WRITE if replace else NOT_READ).format(path=shown))
        if seen != hashlib.sha256(data).hexdigest():
            raise ToolError(CHANGED_SINCE_READ.format(path=shown))

    def forget(self) -> None:
        self.files.clear()


@dataclass
class ToolContext:
    cwd: Path
    settings: dict[str, Any]
    shell: ShellInfo
    # Folders outside the project that the read-only tools can read: the skill folders.
    read_roots: tuple[Path, ...] = ()
    # The preview host of the session (preview.py): servers and the agent browser. None outside a session.
    preview: Any = None
    # The background tasks of the session (tasks.py). None outside a session, for example in a subagent.
    tasks: Any = None
    # The model of the session accepts images. A tool can then give an image to the model.
    image_input: bool = False
    # Ask the user and wait for the reply: a question card or a plan card (tools/interact.py).
    # None in a subagent: it has no user to ask.
    ask: Any = None
    # Change the permission mode of the session, for example after the user accepts a plan.
    set_mode: Any = None
    # A function that returns the model of the session ("provider/model"), for example for routine_create.
    model: Any = None
    # The files that the agent read (ReadState). None: edit and write do not check reads, for example in a test.
    reads: ReadState | None = None

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
    image: str | None = None  # A data URL of an image for the model, for example a screenshot.
    created: list[str] = field(default_factory=list)  # New PDF and Word files, for the chat cards (created.py).
    card: dict[str, Any] | None = None  # A card for the chat: files that the agent sent, or an artifact (share.py).
    stop_turn: bool = False  # The turn stops after this result, for example when the user rejects a plan.
    # True: the tool applied the output limit itself (head and tail, or pages). The agent must not cut the
    # output again, because a second cut from the end removes the tail, the exit code, and the paging hint.
    limited: bool = False


@dataclass
class Approval:
    """What the permission gate needs for one tool call.

    ``key`` is the value that permission rules match: a command or a path.
    ``rule`` is the rule that ``allow_always`` adds to the project settings.
    ``tool`` is the tool name that the rules use, if it is not the name of the tool. For
    example, ``preview_start`` uses the ``server(<command>)`` rules of the dev servers.
    ``input`` replaces the tool arguments in the request to the user, if the arguments do
    not show what the tool does. For example, ``preview_start`` shows the server command.
    """

    key: str
    rule: str
    diff: str | None = None
    tool: str | None = None
    input: dict[str, Any] | None = None


class Tool:
    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {"type": "object", "properties": {}}
    needs_approval: bool = False
    # True if the tool changes nothing (an MCP tool with readOnlyHint). Auto mode then runs it with no check.
    read_only: bool = False

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
