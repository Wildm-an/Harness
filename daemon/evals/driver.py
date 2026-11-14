"""Run one trial: a real daemon, the real agent loop, and a real model, over the WebSocket protocol of the client.

The driver starts a daemon process with its own HARNESS_HOME, copies the workspace of the task, sends the
prompts, and answers the permission, question, and plan cards from the policy of the task. A safety net denies
each command that a hard rule of auto mode catches, whatever the policy says.

There is no sandbox (docs/AUTO_MODE.md). Run real-model evals in a container, a virtual machine, or a CI runner.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from websockets.sync.client import connect

from harness_daemon.auto_mode import hard_rule
from harness_daemon.permissions import rule_matches

from .tasks import Task
from .trial import Trial, file_text, workspace_files

DAEMON_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class ModelSpec:
    """The model of the run. ``provider`` is an entry of providers.json, with "api_key_env" and no inline key."""

    label: str  # "<provider>/<model>"
    provider: dict[str, Any] | None = None  # None: the daemon at daemon_url has its own providers.json.


def prepare_workspace(task: Task, trial_dir: Path) -> Trial:
    ws = trial_dir / "ws"
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(task.workspace, ws)
    if task.settings:
        (ws / ".harness").mkdir(exist_ok=True)
        (ws / ".harness" / "settings.json").write_text(json.dumps(task.settings), encoding="utf-8")
    for command in task.setup:
        command = command.replace("{python}", f'"{sys.executable}"')
        subprocess.run(command, shell=True, cwd=ws, check=True, capture_output=True)
    baseline = workspace_files(ws)
    return Trial(task=task, workspace=ws, baseline=baseline,
                 baseline_text={p: file_text(ws / p) or "" for p in baseline})


def _start_daemon(trial_dir: Path, model: ModelSpec) -> tuple[subprocess.Popen, str, str]:
    home, claude, user = trial_dir / "home", trial_dir / "claude", trial_dir / "userhome"
    for folder in (home, claude, user):
        folder.mkdir(parents=True, exist_ok=True)
    provider_name = model.label.split("/", 1)[0]
    if model.provider is not None:
        (home / "providers.json").write_text(json.dumps({provider_name: model.provider}), encoding="utf-8")
    (home / "settings.json").write_text(json.dumps({"prompt_suggestions": False, "web_search": "off",
                                                     "auto_memory": False}), encoding="utf-8")
    token = secrets.token_hex(16)
    env = dict(os.environ, HARNESS_HOME=str(home), CLAUDE_CONFIG_DIR=str(claude), HARNESS_TOKEN=token,
               HOME=str(user), USERPROFILE=str(user), GIT_CONFIG_GLOBAL=str(user / ".gitconfig"))
    proc = subprocess.Popen([sys.executable, "-m", "harness_daemon", "--port", "0", "--exit-on-stdin-eof"],
                            cwd=DAEMON_DIR, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=open(trial_dir / "daemon.log", "w", encoding="utf-8"), text=True)
    ready = json.loads(proc.stdout.readline())
    return proc, f"ws://127.0.0.1:{ready['port']}/ws", token


def _key(request: dict[str, Any]) -> str:
    data = request.get("input") or {}
    if request.get("tool") == "bash":
        return str(data.get("command") or "")
    if isinstance(data, dict) and isinstance(data.get("path"), str):
        return data["path"]
    return json.dumps(data, sort_keys=True)


def answer(task: Task, request: dict[str, Any]) -> dict[str, Any]:
    """The reply to a card, from the policy of the task."""
    kind = request.get("kind")
    if kind == "question":
        answers = task.answers.get("question")
        values = None if answers in (None, "skip") else answers
        return {"type": "question.reply", "request_id": request["request_id"], "answers": values}
    if kind == "plan":
        reply = {"type": "plan.reply", "request_id": request["request_id"],
                 "decision": task.answers.get("plan", "reject")}
        if reply["decision"] == "accept":
            reply["mode"] = task.answers.get("plan_mode", "acceptEdits")
        if reply["decision"] == "revise":
            reply["feedback"] = task.answers.get("feedback", "Make the plan shorter.")
        return reply
    tool, key = request.get("tool") or "", _key(request)
    policy = task.approvals
    if tool == "bash" and hard_rule("bash", key):
        decision = "deny"  # The safety net of the runner.
    elif any(rule_matches(r, tool, key) for r in policy.get("deny") or []):
        decision = "deny"
    elif any(rule_matches(r, tool, key) for r in policy.get("allow") or []):
        decision = "allow_once"
    else:
        decision = "allow_once" if policy.get("default", "deny") == "allow" else "deny"
    return {"type": "permission.reply", "request_id": request["request_id"], "decision": decision}


def run_trial(task: Task, model: ModelSpec, trial_dir: Path, daemon_url: str | None = None,
              token: str | None = None) -> Trial:
    """One trial. With ``daemon_url`` and ``token`` the driver uses that daemon (the self-tests)."""
    trial_dir.mkdir(parents=True, exist_ok=True)
    trial = prepare_workspace(task, trial_dir)
    proc = None
    try:
        if daemon_url is None:
            proc, daemon_url, token = _start_daemon(trial_dir, model)
        _session(trial, model, daemon_url, token or "")
    except TimeoutError:
        trial.timed_out = True
    except Exception as e:  # noqa: BLE001 - the trial records the error.
        trial.error = f"{type(e).__name__}: {e}"
    finally:
        if proc is not None:
            proc.stdin.close()
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
        (trial_dir / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in trial.events), encoding="utf-8")
        (trial_dir / "approvals.jsonl").write_text("".join(json.dumps(a) + "\n" for a in trial.approvals),
                                                   encoding="utf-8")
    return trial


def _session(trial: Trial, model: ModelSpec, url: str, token: str) -> None:
    task = trial.task
    deadline = time.monotonic() + task.timeout_s
    with connect(url, max_size=64 * 1024 * 1024) as ws:
        def send(message: dict[str, Any]) -> None:
            ws.send(json.dumps(message))

        def recv() -> dict[str, Any]:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            message = json.loads(ws.recv(timeout=left))
            trial.events.append(message)
            return message

        send({"type": "auth", "token": token})
        send({"type": "session.new", "cwd": str(trial.workspace), "model": model.label,
              "permission_mode": task.permission_mode})
        while (message := recv())["type"] != "session.ready":
            if message["type"] == "error":
                raise RuntimeError(message.get("message"))
        trial.session_id = message.get("session_id")
        for prompt in task.turns:
            send({"type": "prompt", "text": prompt})
            try:
                while True:
                    message = recv()
                    if message["type"] == "permission.request":
                        reply = answer(task, message)
                        trial.approvals.append({"request": message, "reply": reply})
                        send(reply)
                    elif message["type"] == "turn.end":
                        trial.stop_reasons.append(message.get("stop_reason") or "")
                        break
            except TimeoutError:
                send({"type": "interrupt"})
                raise
        send({"type": "session.export", "session_id": trial.session_id})
        try:
            while (message := recv())["type"] != "session.export":
                pass
        except TimeoutError:
            return
