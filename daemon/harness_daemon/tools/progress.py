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
MAX_RECAP = 300  # Characters, as in the Claude app: about 40 words.
MAX_ASK = 100


class UpdatePlanTool(Tool):
    name = "update_plan"
    description = (
        "Show the user your plan for a task of more than one step, as a list under your message. "
        "Send the whole list each time: short steps (at most 7 words) in order, each with a status: "
        "pending, in_progress, or completed. Keep exactly one step in_progress while you work. "
        "Call it at the start of the task, again as soon as each step finishes (before you start the next "
        "step), and when the plan changes. Do not mark many steps completed at the end. "
        "After the user interrupts you or gives a new instruction, send the new whole list. "
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
        f"checked. 2 or 3 short sentences, about 40 words, {MAX_RECAP} characters or less. Do not list "
        "each check or step that you did: the details go in your final answer. When the next move is "
        f"the user's decision, add one short question in 'ask' ({MAX_ASK} characters or less), and one "
        "or two answer buttons in 'actions': the first is your "
        "recommendation. A button has a label of 1 to 3 words, and a message that it sends as the "
        "user's next prompt. Call it once, as the last tool call of the turn, then write your final "
        "answer. Before wrap_up, call update_plan with each finished step completed. Do not use it for a "
        "short answer to a question."
    )
    parameters = {
        "type": "object",
        "properties": {
            "recap": {"type": "string", "description": (
                f"2 or 3 short sentences, {MAX_RECAP} characters or less: what changed, and what is not done.")},
            "ask": {"type": "string", "description": f"Optional: one short question for a decision of the user, {MAX_ASK} characters or less."},
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
        if len(recap.strip()) > MAX_RECAP:
            raise ToolError(f"recap has {len(recap.strip())} characters. Give 2 or 3 short sentences, {MAX_RECAP} "
                            "characters or less: what is now true, and what is not done. Put the details in your "
                            "final answer.")
        if len(str(args.get("ask") or "").strip()) > MAX_ASK:
            raise ToolError(f"ask has more than {MAX_ASK} characters. Ask only the decision, in one short sentence.")
        actions = args.get("actions") or []
        if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
            raise ToolError(f"actions must be a list of at most {MAX_ACTIONS} buttons.")
        for action in actions:
            if not isinstance(action, dict) or not str(action.get("label", "")).strip():
                raise ToolError("Each action needs a label.")
        if actions and not str(args.get("ask") or "").strip():
            raise ToolError("Buttons answer a question: give 'ask' too.")
        return ToolResult("Shown to the user. Now write your final answer.")
