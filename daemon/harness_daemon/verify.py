"""The verification gate: a project command (tests, a type check, or a lint) that runs when the agent ends a turn
that changed files.

The research behind it (reports in the project history): the most common failure of coding agents is a turn
that changes code, reads it again, and stops with no check. A prompt rule asks for a check. This gate runs it.

The command is the setting "verify_command" of the project (.harness/settings.json). On a failure the agent
gets the end of the output in a [Harness: ...] note and continues. On a pass the agent gets nothing: a silent
pass saves context. The command has the trust of a hook: the user wrote it in a settings file. A deny rule of
the project and, in auto mode, a hard rule still stop it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import project_settings_path, read_json
from .memory import project_root
from .tools.shell import ShellInfo, command_env, run_command

VERIFY_TIMEOUT = 300  # Seconds. The setting "verify_timeout" changes it.
VERIFY_MAX_TIMEOUT = 3600
VERIFY_TAIL_CHARS = 4000

FAILURE_NOTE = """\
[Harness: The verify command of this project failed after your changes.
Command: {command}
Exit code: {exit_code}
The end of its output:
{tail}
Fix the cause, if your changes caused it. Do not change or remove a test only to make the command pass. \
If the failure was there before your changes, or you cannot fix it, stop and tell the user. \
The Harness runs the command again when you change files and end the turn.{before}]"""
PASSED_BEFORE = " The command passed earlier in this session."

START_NOTICE = "Running the verify command: {command}"
PASS_NOTICE = "The verify command passed in {seconds:.0f} s: {command}"
FAIL_NOTICE = "The verify command failed (exit code {exit_code}). The agent continues."
TIMEOUT_NOTICE = ("The verify command did not end in {timeout} s and was stopped: {command}. Set verify_timeout, "
                  "or use a faster command.")
LIMIT_NOTICE = "The verify command still fails after {runs} runs: {command}. The turn ended."
BLOCKED_NOTICE = "A deny rule or a safety rule blocks the verify command: {command}. The Harness did not run it."

# Hook point B: the gate also runs before the recap box of wrap_up, so that the recap is true.
WRAP_UP_FAILED = "The recap was not shown, because the verify command failed."
WRAP_UP_DONE = "Shown to the user. {state} Now write your final answer."
WRAP_UP_STATES = {
    "passed": "The verify command passed: {command}.",
    "failed": "The verify command failed (exit code {exit_code}): {command}. Say that in your final answer.",
    "timeout": "The verify command did not end in {timeout} s: {command}. Say that in your final answer.",
}


@dataclass
class VerifyResult:
    command: str
    status: str  # "passed", "failed", "timeout", or "blocked"
    exit_code: int | None
    seconds: float
    tail: str  # The end of the output. Empty for "passed".

    def event(self, runs: int) -> dict[str, Any]:
        """The "verify" object of turn.end."""
        return {"command": self.command, "status": self.status, "exit_code": self.exit_code,
                "seconds": round(self.seconds, 1), "runs": runs}


def verify_command(settings: dict[str, Any], cwd: Path) -> str | None:
    """The verify command of the project, or None. A worktree with no value uses the file of its project."""
    value = settings.get("verify_command")
    if not (isinstance(value, str) and value.strip()):
        root = project_root(Path(cwd))
        if root != Path(cwd):
            value = read_json(project_settings_path(root), {}).get("verify_command")
    return value.strip() if isinstance(value, str) and value.strip() else None


def verify_timeout(settings: dict[str, Any]) -> int:
    try:
        value = int(settings.get("verify_timeout") or VERIFY_TIMEOUT)
    except (TypeError, ValueError):
        value = VERIFY_TIMEOUT
    return min(max(value, 1), VERIFY_MAX_TIMEOUT)


def output_tail(text: str, limit: int) -> str:
    """The end of the output, cut at a line start."""
    text = text.rstrip()
    if len(text) <= limit:
        return text
    tail = text[-limit:]
    newline = tail.find("\n")
    if 0 <= newline < len(tail) - 1:
        tail = tail[newline + 1:]
    return f"[... {len(text) - len(tail)} earlier characters removed]\n{tail}"


async def run_verify(command: str, cwd: Path, shell: ShellInfo, timeout: int, tail_chars: int,
                     changed: list[str]) -> VerifyResult:
    """Run the command. HARNESS_CHANGED_FILES gives the changed relative paths, one on each line."""
    env = command_env({"HARNESS_PROJECT_DIR": str(cwd), "HARNESS_CHANGED_FILES": "\n".join(changed)})
    start = time.monotonic()
    result = await run_command(command, cwd, shell, timeout, env=env)
    seconds = time.monotonic() - start
    if result.timed_out:
        return VerifyResult(command, "timeout", None, seconds, output_tail(result.output, tail_chars))
    if result.returncode:
        return VerifyResult(command, "failed", result.returncode, seconds, output_tail(result.output, tail_chars))
    return VerifyResult(command, "passed", 0, seconds, "")


def wrap_up_output(result: VerifyResult, timeout: int) -> str:
    """The wrap_up result after a verify run in the turn: it names the state, so the final answer is true."""
    state = WRAP_UP_STATES.get(result.status)
    if state is None:
        return WRAP_UP_DONE.format(state="").replace("  ", " ")
    return WRAP_UP_DONE.format(state=state.format(command=result.command, exit_code=result.exit_code, timeout=timeout))


def failure_note(result: VerifyResult, passed_before: bool) -> str:
    return FAILURE_NOTE.format(command=result.command, exit_code=result.exit_code, tail=result.tail or "(no output)",
                               before=PASSED_BEFORE if passed_before else "")
