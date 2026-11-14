from __future__ import annotations

from typing import Any

from .. import sandbox
from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_bool, get_int, truncate
from .shell import command_env, run_command

ESCAPE = "dangerouslyDisableSandbox"  # The Claude Code name.
ESCAPE_PARAMETER = {
    "type": "boolean",
    "description": "Run the command outside the sandbox. Use it only after the sandbox caused a failure. The user "
                   "approves each command outside the sandbox. Optional.",
}
SANDBOX_HINT = ("[The command ran in the sandbox: no network, and writes only in the project folder and the temp "
                "folder. If the sandbox caused the failure, run the command again with dangerouslyDisableSandbox: "
                "true. The user then approves it.]")
SANDBOX_HINT_LOCKED = ("[The command ran in the sandbox: no network, and writes only in the project folder and the "
                       "temp folder. If the sandbox caused the failure, tell the user. The settings do not allow "
                       "commands outside the sandbox.]")
UNAVAILABLE_ERROR = ("The sandbox is on, but it is not available: {reason} The setting sandbox.failIfUnavailable is "
                     "true, so the command did not run. Tell the user.")


class BashTool(Tool):
    name = "bash"
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command to run."},
            "timeout": {"type": "integer", "description": "Timeout in seconds. Optional."},
            "run_in_background": {
                "type": "boolean",
                "description": "Run the command as a background task and return at once, for a long build, "
                               "test run, or watcher. Read its output later with task_output. Optional.",
            },
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

    @staticmethod
    def _sandbox() -> tuple[dict[str, Any], dict[str, str]]:
        config = sandbox.sandbox_config()
        return config, sandbox.sandbox_status(config)

    def schema(self, ctx: ToolContext) -> dict[str, Any]:
        result = super().schema(ctx)
        config, status = self._sandbox()
        if status["state"] == "ready" and config["allowUnsandboxedCommands"]:
            # The parameter is in the schema only while the sandbox is on, as in Claude Code.
            parameters = dict(self.parameters)
            parameters["properties"] = {**self.parameters["properties"], ESCAPE: ESCAPE_PARAMETER}
            result["function"]["parameters"] = parameters
        return result

    def describe(self, ctx: ToolContext) -> str:
        shell = ctx.shell.name
        lines = [
            f"Run a command with {shell} in the project folder. Each call starts a new shell in the project "
            "folder, so a cd does not stay for the next call.",
            "",
            "Use it for commands that have no tool: git, package managers, tests, builds, and scripts.",
            "",
            "Do not use it for these jobs. Use the tool instead:",
            "- Read a file: use read, not cat, head, tail, or Get-Content.",
            "- Find files by name: use glob, not find, ls, or dir.",
            "- Find text in files: use grep, not grep, rg, findstr, or Select-String.",
            "- Change a file: use edit or write, not sed, awk, echo, or a redirect (>).",
            "- Talk to the user: write text in your reply, not echo.",
            "",
            "Usage notes:",
            f"- The default timeout is {ctx.settings['bash_timeout']} seconds, and the maximum is "
            f"{ctx.settings['bash_max_timeout']} seconds. For a long build, test run, or watcher, set "
            "run_in_background and read the output later with task_output.",
            "- Do not run commands that wait for input. Use flags such as --yes or -y.",
            "- Do not start servers that do not stop, unless you use run_in_background.",
            "- Long output is cut, and the end is kept. Errors are usually at the end. The note at the cut names a "
            "file with the full output.",
            "- When commands do not depend on each other, make several bash calls in one reply.",
            "- Put quotes around paths that have spaces.",
            "- Before you delete or move files, check the paths.",
            "- Read the exit code and the output before you say that a command worked.",
            "- The command does not get secret environment variables (for example names that end with _TOKEN or "
            "_API_KEY), unless the user keeps them. A login error can have this cause: tell the user.",
        ]
        config, status = self._sandbox()
        if status["state"] == "ready":
            then = ("run the command again with dangerouslyDisableSandbox: true. The user then approves it."
                    if config["allowUnsandboxedCommands"] else "tell the user.")
            lines.append("- The command runs in a sandbox: it has no network, and it can write only in the project "
                         f"folder and the temp folder. If the sandbox blocks a necessary action, {then}")
        if shell == "powershell":
            lines.append("- This is Windows PowerShell 5.1: && and || do not work. Use ; to run commands in sequence.")
        elif shell == "cmd":
            lines.append("- This is cmd.exe: use cmd syntax, not POSIX shell syntax.")
        return "\n".join(lines)

    def _command(self, args: dict[str, Any]) -> str:
        command = args.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ToolError("command is empty.")
        return command.strip()

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        command = self._command(args)
        if command.lstrip().startswith("apply_patch"):
            # Models trained on Codex send apply_patch as a shell command. Tell them which tool to use.
            raise ToolError("This shell has no apply_patch command. Use the edit tool to change a file, and the "
                            "write tool to create one.")
        config, status = self._sandbox()
        if config["enabled"] and status["state"] == "unavailable" and config["failIfUnavailable"]:
            raise ToolError(UNAVAILABLE_ERROR.format(reason=status["reason"]))
        if status["state"] != "ready":
            return Approval(key=command, rule=f"bash({command})")
        return Approval(key=command, rule=f"bash({command})", sandboxed=self._in_sandbox(command, args, config),
                        sandbox_escape=get_bool(args, ESCAPE))

    @staticmethod
    def _in_sandbox(command: str, args: dict[str, Any], config: dict[str, Any]) -> bool:
        """True if the command runs in the sandbox, while the sandbox is ready. A background task runs outside it."""
        return not (get_bool(args, ESCAPE) or args.get("run_in_background") is True
                    or sandbox.is_excluded(command, config))

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        command = self._command(args)
        if args.get("run_in_background") is True:
            return self._start_task(command, args, ctx)
        limit = ctx.settings["bash_max_timeout"]
        timeout = get_int(args, "timeout", ctx.settings["bash_timeout"])
        timeout = min(max(timeout, 1), limit)
        config, status = self._sandbox()
        policy = None
        if status["state"] == "ready" and self._in_sandbox(command, args, config):
            policy = sandbox.prepare_run(ctx.cwd, ctx.output_dir, config)
        env = command_env(sandbox.sandbox_env(policy)) if policy is not None else None
        result = await run_command(command, ctx.cwd, ctx.shell, timeout, env=env, sandbox=policy)
        output = result.output.rstrip("\n") or "(no output)"
        # Keep the end of long command output. Errors are usually at the end.
        output = truncate(output, ctx.settings["max_output_chars"], keep_tail=True, spill_dir=ctx.output_dir)
        if result.timed_out:
            return ToolResult(f"{output}\n[The command timed out after {timeout} seconds and was stopped.]",
                              is_error=True, limited=True)
        if result.returncode:
            hint = ""
            if policy is not None:
                hint = "\n" + (SANDBOX_HINT if config["allowUnsandboxedCommands"] else SANDBOX_HINT_LOCKED)
            return ToolResult(f"{output}\n[Exit code: {result.returncode}]{hint}", is_error=True, limited=True)
        return ToolResult(output, limited=True)

    def _start_task(self, command: str, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..tasks import TaskError

        if ctx.tasks is None:
            raise ToolError("Background tasks are not available here. Run the command without run_in_background.")
        description = args.get("description") if isinstance(args.get("description"), str) else ""
        try:
            task = ctx.tasks.start(command, description)
        except TaskError as e:
            raise ToolError(str(e)) from e
        return ToolResult(f"The command runs as the background task {task.id}. Read its output with "
                          f"task_output, and stop it with task_stop. The next message of the user tells "
                          f"you when it ends.")
