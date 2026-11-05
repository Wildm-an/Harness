"""The start_session tool: the agent starts a new session that runs in the background.

The new session is a nested session of this session: the sidebar shows it under this session. It runs
with no window (server.py, start_child_session), as a routine run does. A window that opens it takes it.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from .base import Approval, Tool, ToolContext, ToolError, ToolResult
from .routines import MODE_NAMES, routine_mode, session_mode

# start(title, prompt, worktree, mode) -> {"id", "folder"}. The session gives it (session.py).
StartFn = Callable[[str, str, bool, str], Awaitable[dict[str, Any]]]

TITLE_CHARS = 80


def _text(args: dict[str, Any], key: str) -> str:
    value = " ".join(str(args.get(key) or "").split()) if key == "title" else str(args.get(key) or "").strip()
    if not value:
        raise ToolError(f"Give '{key}'.")
    return value


class StartSessionTool(Tool):
    name = "start_session"
    needs_approval = True
    parameters = {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "A short title for the sidebar, for example "
                                                       "'Add nested sessions to the sidebar'."},
            "prompt": {"type": "string", "description": "The full task. The new session has no memory of this "
                                                        "conversation: give the goal, the files, the constraints, "
                                                        "and what done looks like."},
            "worktree": {"type": "boolean", "description": "True: the new session works in a new git worktree of "
                                                           "the project, on its own branch. Use it when the work can "
                                                           "touch the same files as this session. Default: false."},
        },
        "required": ["title", "prompt"],
    }

    def __init__(self, start: StartFn):
        self.start = start

    def describe(self, ctx: ToolContext) -> str:
        return ("Start a new session that does a separate task in the background. The sidebar shows the new "
                "session nested under this session. The user can open it, give it instructions, or stop it. Use "
                "this tool only for a task of its own that ends in its own result, for example a separate change, "
                "a branch, or a pull request, and only when the user asks for it or agrees to it. Do not use it "
                "for a small task or for a part of the current task: do that work here, or use the agent tool. "
                "The new session works in the project folder of this session, with the model and the permission "
                "mode of this session. This session does not get the result of the new session. After the start, "
                "tell the user the title of the new session.")

    def _fields(self, args: dict[str, Any], ctx: ToolContext) -> tuple[str, str, bool, str]:
        title = _text(args, "title")[:TITLE_CHARS]
        prompt = _text(args, "prompt")
        worktree = args.get("worktree") is True
        return title, prompt, worktree, routine_mode(None, session_mode(ctx))

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        title, prompt, worktree, mode = self._fields(args, ctx)
        shown = {"title": title, "folder": str(ctx.cwd), "worktree": worktree,
                 "permission_mode": MODE_NAMES[mode], "prompt": prompt}
        return Approval(key=title, rule="start_session", input=shown)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        title, prompt, worktree, mode = self._fields(args, ctx)
        try:
            started = await self.start(title, prompt, worktree, mode)
        except ToolError:
            raise
        except Exception as e:  # noqa: BLE001 - the model gets the reason.
            raise ToolError(f"The session did not start: {e}") from None
        where = "a new git worktree" if worktree else started["folder"]
        return ToolResult(f"Started the session '{title}' in {where}, in {MODE_NAMES[mode]} mode. It runs in the "
                          f"background. The sidebar shows it nested under this session. This session does not get "
                          f"its result.")
