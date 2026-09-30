from __future__ import annotations

from typing import Any

from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_int, truncate
from .shell import run_command


class BashTool(Tool):
    name = "bash"
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command to run."},
            "timeout": {"type": "integer", "description": "Timeout in seconds. Optional."},
            # The client shows it in the list of actions, as Claude Code does. It does not change the command.
            "description": {
                "type": "string",
                "description": "What the command does, in 3 to 8 words, in the past tense, for the user. "
                               "For example: Listed the skill files. Optional.",
            },
        },
        "required": ["command"],
    }
    needs_approval = True

    def describe(self, ctx: ToolContext) -> str:
        return (
            f"Run a command with {ctx.shell.name} in the project folder. "
            f"The default timeout is {ctx.settings['bash_timeout']} seconds. "
            "Do not run commands that wait for input. Do not start servers that do not stop."
        )

    def _command(self, args: dict[str, Any]) -> str:
        command = args.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ToolError("command is empty.")
        return command.strip()

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        command = self._command(args)
        return Approval(key=command, rule=f"bash({command})")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        command = self._command(args)
        limit = ctx.settings["bash_max_timeout"]
        timeout = get_int(args, "timeout", ctx.settings["bash_timeout"])
        timeout = min(max(timeout, 1), limit)
        result = await run_command(command, ctx.cwd, ctx.shell, timeout)
        output = result.output.rstrip("\n") or "(no output)"
        # Keep the end of long command output. Errors are usually at the end.
        output = truncate(output, ctx.settings["max_output_chars"], keep_tail=True)
        if result.timed_out:
            return ToolResult(f"{output}\n[The command timed out after {timeout} seconds and was stopped.]", is_error=True)
        if result.returncode:
            return ToolResult(f"{output}\n[Exit code: {result.returncode}]", is_error=True)
        return ToolResult(output)
