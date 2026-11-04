"""The memory tool: save, read, and delete the auto memories of the project (memory.py)."""

from __future__ import annotations

from typing import Any

from ..memory import TYPES, MemoryError, MemoryStore
from .base import Tool, ToolContext, ToolError, ToolResult


class MemoryTool(Tool):
    name = "memory"
    description = (
        "Save, read, or delete a memory that stays between sessions. action 'save' writes one fact "
        "(name, description, type, content) and updates the index MEMORY.md. A save with an existing "
        "name replaces that memory. action 'read' gives a memory, 'delete' removes it, and 'list' gives "
        "the index. For a feedback or project memory, end the content with a 'Why:' line and a "
        "'How to apply:' line."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["save", "read", "delete", "list"]},
            "name": {"type": "string", "description": "A short kebab-case slug, for example user-role."},
            "description": {"type": "string", "description": "For save: one line that tells when the memory is useful."},
            "type": {"type": "string", "enum": list(TYPES), "description": "For save."},
            "content": {"type": "string", "description": "For save: the fact."},
        },
        "required": ["action"],
    }

    def __init__(self, store: MemoryStore):
        self.store = store

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        action = args.get("action")
        name = str(args.get("name") or "")
        try:
            if action == "save":
                return ToolResult(self.store.save(name, str(args.get("description") or ""),
                                                  str(args.get("type") or ""), str(args.get("content") or "")))
            if action == "read":
                return ToolResult(self.store.read(name))
            if action == "delete":
                return ToolResult(self.store.delete(name))
            if action == "list":
                return ToolResult(self.store.index().strip() or "(No memories yet.)")
        except MemoryError as e:
            raise ToolError(str(e)) from None
        except OSError as e:
            raise ToolError(f"The memory folder cannot be written: {e}") from None
        raise ToolError("'action' must be save, read, delete, or list.")
