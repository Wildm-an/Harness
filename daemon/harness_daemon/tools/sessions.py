"""The session tools: start_session, session_read, and offer_session.

start_session: the agent starts a new session that runs in the background.

The new session is a nested session of this session: the sidebar shows it under this session. It runs
with no window (server.py, start_child_session), as a routine run does. A window that opens it takes it.
"""

from __future__ import annotations

import uuid
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


# -- the other sessions of the project ---------------------------------------------------------------

# The setting "When you ask for an unrelated task" (new_task_prompt), with the labels of the Claude app.
NEW_TASK_CHOICES = {"ask": "Ask me", "here": "Always do it here", "new_session": "Always start a new session"}
OFFER_QUESTION = "Start this in its own session?"
NEW_SESSION = "New session"
DO_IT_HERE = "Do it here"
SEND_THERE = "Send to that session"
END_TURN = " Tell the user in one short line, then end the turn. Do not do the task in this session."


class SessionReadTool(Tool):
    name = "session_read"
    description = ("Read another session of this project: its title, its first prompt, and its last messages. "
                   "Use an id of the session list note. Use it when the user refers to the work of another "
                   "session, and before offer_session when you must know which session fits the task.")
    parameters = {
        "type": "object",
        "properties": {"session_id": {"type": "string", "description": "The id of the session list (8 characters)."}},
        "required": ["session_id"],
    }

    def __init__(self, read: Callable[[str], str]):
        self.read = read

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        try:
            return ToolResult(self.read(str(args.get("session_id") or "")))
        except ValueError as e:
            raise ToolError(str(e)) from None


class OfferSessionTool(Tool):
    """Send a task to its own session: a new nested session, or another session of the project that fits
    the task better. The setting "When you ask for an unrelated task" decides if the user gets a card."""

    name = "offer_session"
    parameters = {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "A short title of the task, for example 'Fix the login form'."},
            "prompt": {"type": "string", "description": "For a new session: the full task, because the new session has "
                                                        "no memory of this conversation. For an existing session: the "
                                                        "message of the user, in the words of the user."},
            "session_id": {"type": "string", "description": "The id of an existing session of the session list that "
                                                            "fits the task better. Leave it out for a new session."},
        },
        "required": ["title", "prompt"],
    }

    def __init__(self, start: StartFn | None, send: Callable[[str, str], Awaitable[dict[str, Any]]] | None,
                 find: Callable[[str], dict[str, Any] | None]):
        self.start = start
        self.send = send
        self.find = find

    def describe(self, ctx: ToolContext) -> str:
        return ("Use this tool first, before other tools, when the latest message of the user asks for a task "
                "that is not part of the work of this session, or that fits another session of the session list "
                "better. Do not use it for a follow-up, a correction, a question about this work, or the next step "
                "of this work: do that here. With session_id, the task goes to that existing session. Without "
                "session_id, a new session starts, nested under this session. The setting \"When you ask for an "
                "unrelated task\" decides: the user gets a card to choose, or the task goes there at once, or it "
                "stays here. The result tells you what to do next.")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        title = _text(args, "title")[:TITLE_CHARS]
        prompt = _text(args, "prompt")
        ref = str(args.get("session_id") or "").strip()
        target = None
        if ref:
            target = self.find(ref)
            if target is None:
                raise ToolError(f"No other session of this project has the id {ref}. Use an id of the session list, "
                                "or leave session_id out for a new session.")
            if self.send is None:
                raise ToolError("This daemon cannot send a prompt to another session. Do the task here.")
        elif self.start is None:
            raise ToolError("This daemon cannot start a session. Do the task here.")
        choice = str(ctx.settings.get("new_task_prompt") or "ask")
        if choice == "here":
            return ToolResult("The setting \"When you ask for an unrelated task\" is \"Always do it here\". Do the "
                              "task in this session now, and do not call offer_session again for it.")
        action = "send" if target else "new"
        if choice != "new_session":
            action = await self._ask(ctx, target)
            if action is None:
                return ToolResult("The user did not answer.", is_error=True, stop_turn=True)
            if action.startswith("answer:"):
                return ToolResult(f"The user answered: \"{action[7:]}\". Follow the answer.")
        if action == "here":
            return ToolResult("The user chose \"Do it here\". Do the task in this session now, and do not call "
                              "offer_session again for it.")
        if action == "send":
            assert target is not None and self.send is not None
            try:
                sent = await self.send(target["id"], prompt)
            except ToolError:
                raise
            except Exception as e:  # noqa: BLE001 - the model gets the reason.
                raise ToolError(f"The prompt did not go to the session: {e}") from None
            return ToolResult(f"Sent the prompt to the session '{sent['title']}'. It works on it there now." + END_TURN)
        assert self.start is not None
        mode = routine_mode(None, session_mode(ctx))
        try:
            await self.start(title, prompt, False, mode)
        except ToolError:
            raise
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"The session did not start: {e}") from None
        return ToolResult(f"Started the session '{title}', nested under this session, in {MODE_NAMES[mode]} mode."
                          + END_TURN)

    async def _ask(self, ctx: ToolContext, target: dict[str, Any] | None) -> str | None:
        """The card of the Claude app: "send", "new", "here", "answer:<text>", or None (no answer)."""
        if ctx.ask is None:
            return "here"
        new = {"label": NEW_SESSION, "description": "A new session works on it, nested under this session."}
        if target:
            name = target["title"] or "Untitled session"
            question = f"Send this to the session \"{name}\"?"
            options = [{"label": SEND_THERE, "description": f"The session \"{name}\" works on it."}]
            if self.start is not None:
                options.append(new)
        else:
            question, options = OFFER_QUESTION, [new]
        options.append({"label": DO_IT_HERE, "description": "This session works on it."})
        questions = [{"question": question, "header": "Session", "options": options, "multiSelect": False}]
        reply = await ctx.ask({"request_id": uuid.uuid4().hex, "kind": "question", "tool": self.name,
                               "input": {"questions": questions}, "questions": questions, "diff": None, "rule": None})
        if not isinstance(reply, dict):
            return None
        answer = str((reply.get("answers") or {}).get(question) or "").strip()
        if not answer or answer == DO_IT_HERE:
            return "here"
        if target and answer == SEND_THERE:
            return "send"
        if answer == NEW_SESSION and self.start is not None:
            return "new"
        return "answer:" + answer
