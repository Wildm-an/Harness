"""The sandbox of the bash tool (sandbox.py): settings, status, policy, backends, the gate rule, and the bash tool."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from harness_daemon import sandbox
from harness_daemon.config import DEFAULT_SETTINGS, harness_home, load_settings
from harness_daemon.permissions import OUTSIDE_SANDBOX_ASK, SANDBOX_ESCAPE_BLOCK, PermissionGate
from harness_daemon.sandbox import SandboxPolicy
from harness_daemon.tools import Approval, BashTool, ToolContext, ToolError, detect_shell
from harness_daemon.tools import shell as shell_module
from harness_daemon.tools.bash import SANDBOX_HINT, SANDBOX_HINT_LOCKED

from test_auto_mode import ScriptedReviewer


def user_settings(**sandbox_values) -> None:
    home = harness_home()
    home.mkdir(parents=True, exist_ok=True)
    (home / "settings.json").write_text(json.dumps({"sandbox": sandbox_values}), encoding="utf-8")


@pytest.fixture
def ready(monkeypatch):
    """A backend that can run, on each system. No command runs in a real sandbox."""
    monkeypatch.setattr(sandbox, "_backend_problem", lambda backend: None)


# -- settings ------------------------------------------------------------------------------------------------


def test_the_defaults_are_the_claude_code_defaults():
    config = sandbox.sandbox_config()
    assert config == sandbox.normalize_config(None)
    assert config["enabled"] is False and config["autoAllowBashIfSandboxed"] is True
    assert config["allowUnsandboxedCommands"] is True and config["failIfUnavailable"] is False
    assert config["network"] == {"allowedDomains": [], "deniedDomains": [], "allowLocalBinding": False}


def test_a_value_of_the_wrong_type_gets_the_default():
    config = sandbox.normalize_config({"enabled": "yes", "excludedCommands": ["docker *", 3],
                                       "filesystem": {"allowWrite": "x"}})
    assert config["enabled"] is False and config["excludedCommands"] == ["docker *"]
    assert config["filesystem"]["allowWrite"] == []


def test_a_project_settings_file_cannot_change_the_sandbox(project):
    user_settings(enabled=True, excludedCommands=["docker *"])
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"sandbox": {"enabled": False}}))
    assert sandbox.sandbox_config()["enabled"] is True
    assert load_settings(project)["sandbox"]["enabled"] is True


# -- status --------------------------------------------------------------------------------------------------


def test_the_status_is_off_by_default():
    status = sandbox.sandbox_status()
    assert status["state"] == "off" and "sandbox.enabled" in status["reason"]


def test_windows_is_unavailable_with_a_reason():
    status = sandbox.sandbox_status({"enabled": True}, platform="win32")
    assert status == {"state": "unavailable", "backend": "windows", "reason": sandbox.WINDOWS_REASON}


def test_macos_is_unavailable_with_no_sandbox_exec(monkeypatch):
    monkeypatch.setattr(sandbox, "SEATBELT_PROGRAM", "/no/such/sandbox-exec")
    status = sandbox.sandbox_status({"enabled": True}, platform="darwin")
    assert status["state"] == "unavailable" and status["backend"] == "seatbelt"


def _fake_bwrap(folder: Path, code: int, error: str = "") -> None:
    folder.mkdir()
    if os.name == "nt":
        lines = ["@echo off"] + ([f"echo {error} 1>&2"] if error else []) + [f"exit /b {code}"]
        (folder / "bwrap.bat").write_text("\r\n".join(lines) + "\r\n")
    else:
        path = folder / "bwrap"
        path.write_text("#!/bin/sh\n" + (f"echo '{error}' >&2\n" if error else "") + f"exit {code}\n")
        path.chmod(0o755)


def test_linux_is_unavailable_when_bwrap_is_missing(tmp_path, monkeypatch):
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    status = sandbox.sandbox_status({"enabled": True}, platform="linux")
    assert status == {"state": "unavailable", "backend": "bubblewrap", "reason": sandbox.NO_BWRAP}


def test_linux_is_ready_with_a_working_bwrap(tmp_path, monkeypatch):
    _fake_bwrap(tmp_path / "bin", 0)
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    sandbox._probe_bwrap.cache_clear()
    assert sandbox.sandbox_status({"enabled": True}, platform="linux")["state"] == "ready"


def test_linux_is_unavailable_when_bwrap_fails(tmp_path, monkeypatch):
    _fake_bwrap(tmp_path / "bin", 1, "setting up uid map: Permission denied")
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    sandbox._probe_bwrap.cache_clear()
    status = sandbox.sandbox_status({"enabled": True}, platform="linux")
    assert status["state"] == "unavailable" and "Permission denied" in status["reason"]


# -- policy --------------------------------------------------------------------------------------------------


def real(path: Path) -> str:
    return os.path.realpath(path)


def test_the_policy_gives_the_write_roots_and_the_deny_lists(project, tmp_path):
    home = tmp_path / "home"
    (home / ".npm").mkdir(parents=True)
    config = sandbox.normalize_config({"filesystem": {"allowWrite": ["~/shared", "out"], "denyWrite": ["~/keep"],
                                                      "denyRead": ["~/.ssh"], "allowRead": ["~/.ssh/known_hosts"]}})
    policy = sandbox.policy_for(project, tmp_path / "tmp", config, home=home)
    assert policy.write_roots[:2] == (real(project), real(tmp_path / "tmp"))
    assert {real(home / ".npm"), real(home / "shared"), real(project / "out")} <= set(policy.write_roots)
    deny = set(policy.deny_write)
    assert {real(project / ".harness"), real(project / ".git" / "hooks"), real(project / ".git" / "config"),
            real(harness_home()), real(home / ".bashrc"), real(home / "keep")} <= deny
    assert real(project / ".git") not in deny  # git commit writes in .git.
    assert set(policy.deny_read) == {real(harness_home() / n) for n in sandbox.SECRET_FILES} | {real(home / ".ssh")}
    assert policy.allow_read == (real(home / ".ssh" / "known_hosts"),)
    assert policy.network == "off" and policy.temp_dir == real(tmp_path / "tmp")


def test_a_worktree_can_write_the_git_folder_of_the_main_project(tmp_path):
    main_git = tmp_path / "main" / ".git"
    (main_git / "worktrees" / "wt").mkdir(parents=True)
    (main_git / "worktrees" / "wt" / "commondir").write_text("../..\n")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {main_git / 'worktrees' / 'wt'}\n")
    policy = sandbox.policy_for(worktree, tmp_path / "tmp", sandbox.normalize_config(None), home=tmp_path / "h")
    assert real(main_git) in policy.write_roots
    assert real(main_git / "hooks") in policy.deny_write


def test_the_session_temp_folder_is_outside_the_harness_home(project):
    folder = sandbox.session_temp_dir(project, harness_home() / "projects" / "x" / "abc123" / "tool-output")
    assert folder.name == "abc123" and not str(folder).startswith(str(harness_home()))
    assert sandbox.session_temp_dir(project, None).name.startswith("project-")


@pytest.mark.parametrize("command, excluded", [
    ("docker compose up -d", True),
    ("docker compose", True),
    ("docker run x", False),
    ("npm test && docker compose up", True),
    ("make", True),
    ("make build", True),
    ("maker", False),
    ("echo docker compose up", False),
])
def test_is_excluded(command, excluded):
    config = sandbox.normalize_config({"excludedCommands": ["docker compose *", "make"]})
    assert sandbox.is_excluded(command, config) is excluded


def test_no_excluded_commands_excludes_nothing():
    assert sandbox.is_excluded("docker run x", sandbox.normalize_config(None)) is False


# -- backends ------------------------------------------------------------------------------------------------

POLICY = SandboxPolicy(write_roots=("/home/u/proj", "/tmp/harness-sandbox/s1"),
                       deny_write=("/home/u/proj/.harness", "/home/u/.harness"),
                       deny_read=("/home/u/.harness/providers.json", "/home/u/.ssh"),
                       allow_read=("/home/u/.ssh/known_hosts",), temp_dir="/tmp/harness-sandbox/s1")


def test_the_seatbelt_profile():
    profile = sandbox.seatbelt_profile(POLICY)
    assert profile.startswith("(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n")
    assert '(subpath "/home/u/proj")' in profile and '(subpath "/tmp/harness-sandbox/s1")' in profile
    # A later rule wins: the deny paths come after the write roots, and allowRead after denyRead.
    assert profile.index('(subpath "/home/u/proj/.harness")') > profile.index('(subpath "/home/u/proj")')
    assert profile.index("(allow file-read*") > profile.index("(deny file-read*")
    assert "localhost" not in profile


def test_the_seatbelt_profile_escapes_quotes_and_allows_local_binding():
    policy = SandboxPolicy(write_roots=('/a "b"\\c',), allow_local_binding=True)
    profile = sandbox.seatbelt_profile(policy)
    assert '(subpath "/a \\"b\\"\\\\c")' in profile
    assert '(allow network-bind (local ip "localhost:*"))' in profile


def test_wrap_on_macos():
    argv = sandbox.wrap(["/bin/bash", "-c", "ls"], POLICY, platform="darwin")
    assert argv[:2] == ["/usr/bin/sandbox-exec", "-p"]
    assert argv[2] == sandbox.seatbelt_profile(POLICY) and argv[3:] == ["/bin/bash", "-c", "ls"]


def test_wrap_on_linux(monkeypatch):
    monkeypatch.setattr(sandbox, "_find_bwrap", lambda: "/usr/bin/bwrap")
    missing = {"/home/u/.harness/providers.json"}
    argv = sandbox.wrap(["/bin/bash", "-c", "ls"], POLICY, platform="linux",
                        exists=lambda p: p not in missing, is_dir=lambda p: p == "/home/u/.ssh")
    assert argv == [
        "/usr/bin/bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev",
        "--bind", "/home/u/proj", "/home/u/proj",
        "--bind", "/tmp/harness-sandbox/s1", "/tmp/harness-sandbox/s1",
        "--ro-bind", "/home/u/proj/.harness", "/home/u/proj/.harness",
        "--ro-bind", "/home/u/.harness", "/home/u/.harness",
        "--tmpfs", "/home/u/.ssh", "--remount-ro", "/home/u/.ssh",
        "--ro-bind", "/home/u/.ssh/known_hosts", "/home/u/.ssh/known_hosts",
        "--unshare-net", "--", "/bin/bash", "-c", "ls",
    ]


def test_bwrap_hides_a_secret_file():
    args = sandbox.bwrap_args(SandboxPolicy(write_roots=(), deny_read=("/h/token",)),
                              exists=lambda p: True, is_dir=lambda p: False)
    assert ["--ro-bind", "/dev/null", "/h/token"] == args[args.index("/dev/null") - 1:args.index("/dev/null") + 2]


def test_wrap_on_windows_is_not_available():
    with pytest.raises(sandbox.SandboxError):
        sandbox.wrap(["bash", "-c", "ls"], POLICY, platform="win32")


def test_run_command_starts_the_wrapped_argv(project, monkeypatch):
    seen = []

    def fake_wrap(argv, policy):
        seen.append((list(argv), policy))
        return argv

    monkeypatch.setattr(sandbox, "wrap", fake_wrap)
    shell = detect_shell()
    result = asyncio.run(shell_module.run_command("echo hi", project, shell, 30, sandbox=POLICY))
    assert result.returncode == 0 and "hi" in result.output
    assert seen == [([*shell.argv, "echo hi"], POLICY)]


# -- the gate ------------------------------------------------------------------------------------------------


@dataclass
class FakeTool:
    name: str = "bash"
    needs_approval: bool = True
    read_only: bool = False


def check(project: Path, mode: str, approval: Approval, answer: str = "allow_once", reviewer=None):
    asked: list[dict] = []

    async def approver(request: dict) -> str:
        asked.append(request)
        return answer

    gate = PermissionGate(project, approver, mode=lambda: mode)
    gate.auto = reviewer
    result = asyncio.run(gate.check(FakeTool(), {"command": approval.key}, approval))
    return result, asked, gate


def inside(command: str = "npm test") -> Approval:
    return Approval(key=command, rule=f"bash({command})", sandboxed=True)


def outside(command: str = "npm test", escape: bool = False) -> Approval:
    return Approval(key=command, rule=f"bash({command})", sandboxed=False, sandbox_escape=escape)


@pytest.mark.parametrize("mode", ["default", "acceptEdits", "bypassPermissions"])
def test_a_sandboxed_command_runs_with_no_question(project, mode):
    user_settings(enabled=True)
    result, asked, gate = check(project, mode, inside())
    assert result is True and asked == []
    assert gate.last == ("allow", "mode:bypassPermissions" if mode == "bypassPermissions" else "sandbox")


def test_plan_mode_asks_for_a_sandboxed_command(project):
    user_settings(enabled=True)
    result, asked, _ = check(project, "plan", inside())
    assert result is True and len(asked) == 1 and "reason" not in asked[0]


def test_auto_allow_off_asks(project):
    user_settings(enabled=True, autoAllowBashIfSandboxed=False)
    result, asked, _ = check(project, "default", inside())
    assert result is True and len(asked) == 1


@pytest.mark.parametrize("mode", ["default", "acceptEdits", "plan"])
def test_a_command_outside_the_sandbox_asks_with_the_reason(project, mode):
    user_settings(enabled=True)
    result, asked, _ = check(project, mode, outside(escape=True))
    assert result is True and asked[0]["reason"] == OUTSIDE_SANDBOX_ASK and asked[0]["rule"] == "bash(npm test)"


def test_an_allow_rule_runs_a_command_outside_the_sandbox(project):
    user_settings(enabled=True)
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash(npm test)"]}))
    result, asked, _ = check(project, "default", outside(escape=True))
    assert result is True and asked == []


def test_bypass_runs_a_command_outside_the_sandbox(project):
    user_settings(enabled=True)
    result, asked, _ = check(project, "bypassPermissions", outside(escape=True))
    assert result is True and asked == []


def test_a_deny_rule_wins_over_the_sandbox(project):
    user_settings(enabled=True)
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"deny": ["bash(npm test)"]}))
    result, asked, gate = check(project, "default", inside())
    assert result is False and asked == [] and gate.last == ("deny", "deny_rule")


def test_a_hard_rule_match_asks_in_the_sandbox(project):
    user_settings(enabled=True)
    result, asked, _ = check(project, "default", inside("sudo ls"))
    assert result is True and len(asked) == 1 and "safety rule" in asked[0]["reason"]


def test_no_unsandboxed_commands_gives_a_text(project):
    user_settings(enabled=True, allowUnsandboxedCommands=False)
    result, asked, gate = check(project, "default", outside(escape=True))
    assert result == SANDBOX_ESCAPE_BLOCK and asked == [] and gate.last == ("block", "sandbox:locked")
    # An excluded command still runs outside the sandbox, after a question.
    result, asked, _ = check(project, "default", outside())
    assert result is True and asked[0]["reason"] == OUTSIDE_SANDBOX_ASK


def test_auto_mode_runs_a_sandboxed_command_with_no_model(project):
    user_settings(enabled=True)
    reviewer = ScriptedReviewer([])
    result, asked, gate = check(project, "auto", inside("npm install"), reviewer=reviewer)
    assert result is True and asked == [] and reviewer.calls == [] and gate.last == ("allow", "auto:sandbox")


def test_auto_mode_checks_a_command_outside_the_sandbox(project):
    from harness_daemon.auto_mode import Verdict

    user_settings(enabled=True)
    reviewer = ScriptedReviewer([Verdict("allow", "", "ok")])
    result, _, _ = check(project, "auto", outside("npm install", escape=True), reviewer=reviewer)
    assert result is True and reviewer.calls == [("bash", "npm install")]


def test_auto_mode_blocks_a_hard_rule_in_the_sandbox(project):
    user_settings(enabled=True)
    reviewer = ScriptedReviewer([])
    result, _, _ = check(project, "auto", inside("sudo ls"), reviewer=reviewer)
    assert isinstance(result, str) and "Privilege Escalation" in result and reviewer.calls == []


def test_a_call_with_no_sandbox_field_is_as_before(project):
    user_settings(enabled=True)
    result, asked, _ = check(project, "default", Approval(key="npm test", rule="bash(npm test)"))
    assert result is True and len(asked) == 1 and "reason" not in asked[0]


# -- the bash tool -------------------------------------------------------------------------------------------


def ctx(project: Path) -> ToolContext:
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def parameters(project: Path) -> dict:
    return BashTool().schema(ctx(project))["function"]["parameters"]


def test_the_schema_has_the_escape_only_while_the_sandbox_is_ready(project, ready):
    tool = BashTool()
    assert "dangerouslyDisableSandbox" not in parameters(project)
    assert "sandbox" not in tool.describe(ctx(project))
    user_settings(enabled=True)
    assert list(parameters(project)["properties"])[-1] == "dangerouslyDisableSandbox"
    assert "The command runs in a sandbox" in tool.describe(ctx(project))
    assert "dangerouslyDisableSandbox" not in tool.parameters["properties"]  # The class value does not change.
    user_settings(enabled=True, allowUnsandboxedCommands=False)
    assert "dangerouslyDisableSandbox" not in parameters(project)


def test_the_schema_is_as_before_when_the_sandbox_is_unavailable(project, monkeypatch):
    monkeypatch.setattr(sandbox, "_backend_problem", lambda backend: "no backend")
    user_settings(enabled=True)
    assert "dangerouslyDisableSandbox" not in parameters(project)


def prepare(project: Path, args: dict) -> Approval:
    return asyncio.run(BashTool().prepare(args, ctx(project)))


def test_prepare_sets_the_sandbox_fields(project, ready):
    assert prepare(project, {"command": "ls"}).sandboxed is None
    user_settings(enabled=True, excludedCommands=["docker *"])
    assert prepare(project, {"command": "ls"}).sandboxed is True
    assert prepare(project, {"command": "docker ps"}).sandboxed is False
    assert prepare(project, {"command": "ls", "run_in_background": True}).sandboxed is False
    escape = prepare(project, {"command": "ls", "dangerouslyDisableSandbox": True})
    assert escape.sandboxed is False and escape.sandbox_escape is True


def test_fail_if_unavailable_stops_the_command(project, monkeypatch):
    monkeypatch.setattr(sandbox, "_backend_problem", lambda backend: "No backend here.")
    user_settings(enabled=True)
    assert prepare(project, {"command": "ls"}).sandboxed is None  # It runs as now.
    user_settings(enabled=True, failIfUnavailable=True)
    with pytest.raises(ToolError, match="No backend here.*failIfUnavailable"):
        prepare(project, {"command": "ls"})


class Recorder:
    def __init__(self, returncode: int = 0):
        self.calls: list[dict] = []
        self.returncode = returncode

    async def __call__(self, command, cwd, shell, timeout, env=None, sandbox=None):
        self.calls.append({"command": command, "env": env, "sandbox": sandbox})
        return shell_module.CommandResult("out", self.returncode, False)


def run_bash(project: Path, monkeypatch, args: dict, returncode: int = 0):
    recorder = Recorder(returncode)
    monkeypatch.setattr("harness_daemon.tools.bash.run_command", recorder)
    result = asyncio.run(BashTool().run(args, ctx(project)))
    return result, recorder.calls[0]


def test_bash_passes_the_policy_and_the_temp_folder(project, monkeypatch, ready):
    user_settings(enabled=True)
    result, call = run_bash(project, monkeypatch, {"command": "npm test"})
    policy = call["sandbox"]
    assert isinstance(policy, SandboxPolicy) and policy.write_roots[0] == real(project)
    assert call["env"]["TMPDIR"] == call["env"]["TEMP"] == policy.temp_dir and Path(policy.temp_dir).is_dir()
    assert result.output == "out" and not result.is_error


def test_bash_runs_outside_the_sandbox_when_asked(project, monkeypatch, ready):
    user_settings(enabled=True)
    _, call = run_bash(project, monkeypatch, {"command": "npm test", "dangerouslyDisableSandbox": True})
    assert call["sandbox"] is None and call["env"] is None


def test_bash_runs_with_no_sandbox_when_it_is_off(project, monkeypatch, ready):
    result, call = run_bash(project, monkeypatch, {"command": "npm test"}, returncode=1)
    assert call["sandbox"] is None and SANDBOX_HINT not in result.output


def test_the_failure_hint_shows_only_for_a_nonzero_exit_code(project, monkeypatch, ready):
    user_settings(enabled=True)
    failed, _ = run_bash(project, monkeypatch, {"command": "npm test"}, returncode=2)
    assert failed.output.endswith(f"[Exit code: 2]\n{SANDBOX_HINT}")
    passed, _ = run_bash(project, monkeypatch, {"command": "npm test"})
    assert SANDBOX_HINT not in passed.output
    user_settings(enabled=True, allowUnsandboxedCommands=False)
    locked, _ = run_bash(project, monkeypatch, {"command": "npm test"}, returncode=2)
    assert locked.output.endswith(SANDBOX_HINT_LOCKED)


# -- a real backend (macOS and Linux only) -------------------------------------------------------------------

real_backend = pytest.mark.skipif(
    sys.platform == "win32" or sandbox.sandbox_status({"enabled": True})["state"] != "ready",
    reason="No sandbox backend on this computer.")


@real_backend
def test_a_real_sandbox_limits_writes_and_the_network(project, tmp_path, monkeypatch):
    user_settings(enabled=True)
    outside_file = tmp_path / "outside.txt"

    def bash(command: str):
        return asyncio.run(BashTool().run({"command": command}, ctx(project)))

    assert not bash("touch inside.txt").is_error and (project / "inside.txt").exists()
    assert bash(f"touch '{outside_file}'").is_error and not outside_file.exists()
    assert bash("touch .harness/settings.json").is_error
    assert bash("echo x > \"$TMPDIR/t.txt\"").is_error is False
    assert bash("curl -sS --max-time 5 https://example.com || python3 -c "
                "\"import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)\"").is_error
