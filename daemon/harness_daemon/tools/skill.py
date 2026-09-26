from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable

from .base import Tool, ToolContext, ToolError, ToolResult

if TYPE_CHECKING:
    from ..skills import Skill

# Called when a skill starts. The agent applies the allowed-tools of the skill.
Activate = Callable[["Skill"], None]
# Runs a skill with "context: fork" in a subagent. Returns the report of the subagent.
RunFork = Callable[["Skill", str], Awaitable[str]]


class SkillTool(Tool):
    name = "skill"
    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "The skill name, from the skill list in the system prompt."},
            "arguments": {"type": "string", "description": "Arguments for the skill. Optional."},
        },
        "required": ["name"],
    }

    def __init__(self, skills: dict[str, "Skill"], activate: Activate, run_fork: RunFork):
        self.skills = skills
        self.activate = activate
        self.run_fork = run_fork

    def describe(self, ctx: ToolContext) -> str:
        return (
            "Load the instructions of a skill. Call this tool before you start a task that matches "
            "a skill description in the system prompt. Then follow the instructions that it returns."
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..skills import render_skill

        name = str(args.get("name") or "").strip().lstrip("/")
        skill = self.skills.get(name) or next(
            (s for key, s in self.skills.items() if key.lower() == name.lower()), None)
        if skill is None or not skill.model_invocable:
            names = ", ".join(n for n, s in self.skills.items() if s.model_invocable)
            raise ToolError(f"Unknown skill: {name}. The skills are: {names or 'none'}.")
        arguments = str(args.get("arguments") or "")
        self.activate(skill)
        if skill.context == "fork":
            report = await self.run_fork(skill, arguments)
            return ToolResult(f"The skill {skill.name} ran in a separate context. Its report:\n\n{report}")
        return ToolResult(render_skill(skill, arguments, ctx.cwd))
