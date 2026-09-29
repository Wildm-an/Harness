"""Two scenarios for the surveyed plugins.

Hard blocker: the DeepSeek peer gate fails, or the inject list has a service with no shim, or the UI
half registers only into slots with no plan. A plugin with only soft gaps loads, but some of its
features do nothing: listeners for events that Harness does not send, or ctx.x uses outside inject.
"""

import json
from collections import Counter

survey = json.load(open("survey.json", encoding="utf-8"))
gate = json.load(open("gate.json", encoding="utf-8"))
SKIP = {"@hyzyn/dsh-safe", "@jerryweizhihao/dsh-plugin-catalog"}
OWN = {"dataQuality", "lsp"}
EMITTED = {"agent/created", "agent/disposed", "agent/status", "agent/inbox/inserted", "agent/inbox/claimed",
           "agent/pre-step", "agent/request", "agent/request-error", "agent/assistant-stream", "agent/turn-stopping",
           "agent/error", "tools/pre-execute", "tools/execute", "tools/post-execute", "tools/result",
           "system-prompt/assemble", "session/event", "session/created", "session/disposed", "settings/document-updated",
           "llm/stream"}
UI_NONE = ("conversation.", "tool.call", "tool.view", "sidebar.right", "sidebar.workspaces", "sidebar.session", "rightbar")

PLAN = {"tools": 1, "commands": 1, "skills": 1, "systemPrompt": 1, "logger": 1, "timer": 1, "agents": 2, "approval": 2,
        "llm": 3, "agentDefaultModel": 3, "settings": 4, "credentials": 4, "sessions": 4, "userQuestions": 4,
        "attachments": 4, "storage": 4, "tokenMeter": 4}
EXTENDED = {**PLAN, "storageDomain": 4, "workspaceRegistry": 4, "fs": 4, "sandboxPolicy": 4, "subprocess": 4,
            "webServer": 5, "webRuntime": 5, "connection": 5}


def judge(r, shims):
    if gate.get(r["name"]):
        return "gate", ["fails the peer gate"]
    inject = set(r["inject"]) - OWN
    hard = sorted(s for s in inject if s not in shims)
    ui_none = sorted({s for s in r.get("slots", []) if s.startswith(UI_NONE)})
    ui_ok = r["client"] and not ui_none
    soft = sorted({s for s in r["ctx_used"] if s not in shims and s not in OWN and s[0].islower() and len(s) > 3
                   and s in {"webServer", "webRuntime", "connection", "fs", "subprocess", "sandboxPolicy", "subagents",
                             "web", "storageDomain", "workspaceRegistry", "sessionPersistence", "sessionQuery",
                             "sessionProjectionCache", "compaction", "loader", "profileContext", "agentPresets",
                             "permissionPresets", "terminals", "jobs", "shell", "sessionTitle"}})
    soft += sorted(e for e in r["events"] if e not in EMITTED and e != "loader/volatile-update")
    if hard:
        return "blocked", ["inject: " + ", ".join(hard)]
    phase = max([shims.get(s, 1) for s in inject] + [1])
    if r["client"]:
        if ui_ok:
            phase = max(phase, 5)
        else:
            soft.append("UI slots: " + ", ".join(ui_none[:3]))
    return ("full" if not soft else "partial"), [f"phase {phase}"] + soft


for label, shims in (("A: the current plan", PLAN), ("B: plan + storageDomain, workspaceRegistry, fs, sandboxPolicy, subprocess, webServer, webRuntime, connection", EXTENDED)):
    results = {r["name"]: judge(r, shims) for r in survey if r["name"] not in SKIP}
    print("==", label)
    print("  ", Counter(v[0] for v in results.values()))
    for name, (kind, notes) in results.items():
        print(f"   {kind:<8} {name:<40} {'; '.join(notes)}")
    json.dump(results, open(f"scenario-{label[0]}.json", "w", encoding="utf-8"), indent=1)
