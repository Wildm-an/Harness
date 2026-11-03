"""The task list and the end-of-turn box, as in Claude Code.

``update_plan``: the agent shows its plan as a list of steps. The client draws the latest list under
the latest message: a check mark for a completed step, a spinner for the step in progress, and a
dashed circle for a pending step.

``wrap_up``: at the end of a turn, the agent gives a short recap and, when the user must decide,
one question with one or two answer buttons. The client draws a box. A button sends its message
as the next prompt of the user.

Both tools only show something to the user. They change no file and need no approval. The client
reads their arguments from the tool calls of the conversation.
"""

from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult

STATUSES = ("pending", "in_progress", "completed")
MAX_STEPS = 12
MAX_ACTIONS = 2


class UpdatePlanTool(Tool):
    name = "update_plan"
    description = (
        "Show the user your plan for a task of more than one step, as a list under your message. "
        "Send the whole list each time: short steps (at most 7 words) in order, each with a status: "
        "pending, in_progress, or completed. Keep exactly one step in_progress while you work. "
        "Call it at the start of the task, and again when a step finishes or the plan changes. "
        "Do not use it for a one-step answer."
    )
    parameters = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "description": "The whole plan, in order (1 to 12 steps).",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The step, in a few words."},
                        "status": {"type": "string", "enum": list(STATUSES)},
                    },
                    "required": ["content", "status"],
                },
            },
        },
        "required": ["items"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        items = args.get("items")
        if not isinstance(items, list) or not items:
            raise ToolError("items must be a list of 1 to 12 steps.")
        if len(items) > MAX_STEPS:
            raise ToolError(f"Give at most {MAX_STEPS} steps.")
        for item in items:
            if not isinstance(item, dict) or not str(item.get("content", "")).strip():
                raise ToolError("Each step needs a content text.")
            if item.get("status") not in STATUSES:
                raise ToolError("Each status must be pending, in_progress, or completed.")
        done = sum(1 for i in items if i["status"] == "completed")
        return ToolResult(f"Plan shown: {done} of {len(items)} steps completed.")


class WrapUpTool(Tool):
    name = "wrap_up"
    description = (
        "At the end of a turn in which you changed files, ran commands, or did work of more than one "
        "step, show the user a short recap in a box: what is now true and what is not done or not "
        "checked (2 or 3 sentences). When the next move is the user's decision, add one short "
        "question in 'ask', and one or two answer buttons in 'actions': the first is your "
        "recommendation. A button has a label of 1 to 3 words, and a message that it sends as the "
        "user's next prompt. Call it once, as the last tool call of the turn, then write your final "
        "answer. Do not use it for a short answer to a question."
    )
    parameters = {
        "type": "object",
        "properties": {
            "recap": {"type": "string", "description": "2 or 3 short sentences: what changed, and what is not done."},
            "ask": {"type": "string", "description": "Optional: one short question for a decision of the user."},
            "actions": {
                "type": "array",
                "description": "Optional: 1 or 2 answer buttons. The first is your recommendation.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "The button text, 1 to 3 words."},
                        "message": {"type": "string", "description": "The prompt that the click sends. Default: the label."},
                    },
                    "required": ["label"],
                },
            },
        },
        "required": ["recap"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        recap = args.get("recap")
        if not isinstance(recap, str) or not recap.strip():
            raise ToolError("recap is empty.")
        actions = args.get("actions") or []
        if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
            raise ToolError(f"actions must be a list of at most {MAX_ACTIONS} buttons.")
        for action in actions:
            if not isinstance(action, dict) or not str(action.get("label", "")).strip():
                raise ToolError("Each action needs a label.")
        if actions and not str(args.get("ask") or "").strip():
            raise ToolError("Buttons answer a question: give 'ask' too.")
        return ToolResult("Shown to the user. Now write your final answer.")
