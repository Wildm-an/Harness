"""The tools that wait for the user in a turn, as AskUserQuestion and ExitPlanMode in Claude Code.

- ``ask_user_question``: 1 to 4 questions, each with 2 to 4 options. The client shows a question card.
  The user picks an option, types another answer, or skips.
- ``exit_plan_mode``: in plan mode, the agent gives its plan. The client shows a plan card. The user
  accepts it in a mode (the mode changes and the work starts), asks for changes, or rejects it.

The requests go through the permission channel of the session (``ToolContext.ask``) with a ``kind``.
Only the agent that the user talks to has these tools. A subagent has no user to ask.
"""

from __future__ import annotations

import uuid
from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult

MAX_QUESTIONS = 4
MAX_HEADER = 12
ACCEPT_MODES = ("acceptEdits", "default", "auto", "bypassPermissions")
MAX_PLAN = 40_000


def _clean_questions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_QUESTIONS:
        raise ToolError(f"'questions' must be a list of 1 to {MAX_QUESTIONS} questions.")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for n, q in enumerate(value, 1):
        if not isinstance(q, dict):
            raise ToolError(f"Question {n} must be an object with question, header, options, and multiSelect.")
        text = str(q.get("question") or "").strip()
        if not text:
            raise ToolError(f"Question {n} has no text.")
        if text in seen:
            raise ToolError(f"Two questions have the same text: {text}")
        seen.add(text)
        header = str(q.get("header") or "").strip()[:MAX_HEADER] or f"Question {n}"
        options = q.get("options")
        if not isinstance(options, list) or not 2 <= len(options) <= 4:
            raise ToolError(f"Question {n} must have 2 to 4 options.")
        clean: list[dict[str, str]] = []
        for o in options:
            if isinstance(o, str):
                o = {"label": o}
            if not isinstance(o, dict) or not str(o.get("label") or "").strip():
                raise ToolError(f"Each option of question {n} must have a label.")
            label = str(o["label"]).strip()
            if any(c["label"] == label for c in clean):
                raise ToolError(f"Two options of question {n} have the same label: {label}")
            clean.append({"label": label, "description": str(o.get("description") or "").strip()})
        out.append({"question": text, "header": header, "options": clean,
                    "multiSelect": q.get("multiSelect") is True})
    return out


def _stopped(reply: Any) -> bool:
    """The turn stopped, or the client went away: the request got no answer."""
    return not isinstance(reply, dict)


class AskUserQuestionTool(Tool):
    name = "ask_user_question"
    description = (
        "Ask the user 1 to 4 questions while you work, each with 2 to 4 options. Use it when you must "
        "know a choice of the user to continue, for example between two designs, or to make a vague "
        "request clear. Do not use it for a question that the code or the docs can answer. The user can "
        "also type another answer. Put your recommended option first, and add \" (Recommended)\" to its "
        "label. The result gives the answers."
    )
    parameters = {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_QUESTIONS,
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "description": "The full question. End it with a question mark."},
                        "header": {"type": "string", "description": f"A short label, {MAX_HEADER} characters or less."},
                        "options": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": {"type": "string", "description": "1 to 5 words."},
                                    "description": {"type": "string", "description": "What the option means."},
                                },
                                "required": ["label"],
                            },
                        },
                        "multiSelect": {"type": "boolean", "description": "True: the user can pick more than one option."},
                    },
                    "required": ["question", "header", "options"],
                },
            },
        },
        "required": ["questions"],
    }

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> None:
        _clean_questions(args.get("questions"))
        return None

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        if ctx.ask is None:
            raise ToolError("No user can answer here. Decide yourself, and tell the user in your report.")
        questions = _clean_questions(args.get("questions"))
        reply = await ctx.ask({"request_id": uuid.uuid4().hex, "kind": "question", "tool": self.name,
                               "input": {"questions": questions}, "questions": questions,
                               "diff": None, "rule": None})
        if _stopped(reply):
            return ToolResult("The user did not answer.", is_error=True, stop_turn=True)
        answers = reply.get("answers")
        if not isinstance(answers, dict) or not answers:
            return ToolResult("The user skipped the questions. Continue with your best choice, and tell the user what you chose.")
        lines = [f'"{q["question"]}" = "{answers[q["question"]]}"' for q in questions if answers.get(q["question"])]
        skipped = [q["question"] for q in questions if not answers.get(q["question"])]
        text = "The user answered: " + ", ".join(lines) + "."
        if skipped:
            text += " The user skipped: " + ", ".join(f'"{s}"' for s in skipped) + "."
        return ToolResult(text + " Continue with these answers.")


class ExitPlanModeTool(Tool):
    name = "exit_plan_mode"
    description = (
        "In plan mode, give the user your plan for approval when it is complete. The plan is Markdown: "
        "the steps, and the files that each step changes. The user accepts it (the mode changes and you "
        "start the work), asks for changes (you get the feedback and stay in plan mode), or rejects it. "
        "Use it only to plan a task that changes files, not after research only."
    )
    parameters = {
        "type": "object",
        "properties": {"plan": {"type": "string", "description": "The plan, in Markdown."}},
        "required": ["plan"],
    }

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> None:
        plan = str(args.get("plan") or "").strip()
        if not plan:
            raise ToolError("Give the plan in 'plan'.")
        if len(plan) > MAX_PLAN:
            raise ToolError(f"The plan is too long: {len(plan)} characters. Keep it under {MAX_PLAN}.")
        return None

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        if ctx.ask is None or ctx.set_mode is None:
            raise ToolError("No user can approve a plan here.")
        if ctx.settings.get("permission_mode") != "plan":
            return ToolResult("Plan mode is not on. Start the work.")
        plan = str(args.get("plan") or "").strip()
        reply = await ctx.ask({"request_id": uuid.uuid4().hex, "kind": "plan", "tool": self.name,
                               "input": {"plan": plan}, "plan": plan, "diff": None, "rule": None})
        if _stopped(reply):
            return ToolResult("The user did not answer.", is_error=True, stop_turn=True)
        decision = reply.get("decision")
        feedback = str(reply.get("feedback") or "").strip()
        if decision == "accept":
            mode = reply.get("mode") if reply.get("mode") in ACCEPT_MODES else "default"
            await ctx.set_mode(mode)
            text = f"The user approved the plan. The permission mode is now {mode}. Start the work now, step by step."
            return ToolResult(text + (f" The user added: {feedback}" if feedback else ""))
        if decision == "revise":
            return ToolResult("The user wants changes to the plan. Plan mode stays on. Change the plan, then call "
                              "exit_plan_mode again." + (f" The feedback: {feedback}" if feedback else ""))
        return ToolResult("The user rejected the plan. Plan mode stays on. Stop, and wait for the user.",
                          stop_turn=True)
