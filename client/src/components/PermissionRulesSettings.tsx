// Settings > Permission rules (docs/UI_RULES.md G2): the allow and deny rules of a project. The user asked to
// move them into Settings, so the sidebar has no "More" list. The rules are in the settings file of the project
// (`.harness/settings.json`, daemon permissions.py). The page has a "Project" select, as Your Harness has.

import { useEffect, useRef, useState } from "react";
import type { DaemonConnection } from "../daemon/connection";
import type { ProjectItem } from "../daemon/protocol";
import { RuleList, type Rules } from "./RulesPanel";
import { Row } from "./SettingsDialog";

/** The rules of one project: the request with "cwd", and the replies with the same "cwd". */
function useProjectRules(conn: DaemonConnection, cwd: string | null, connected: boolean) {
  const [rules, setRules] = useState<(Rules & { cwd: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saving = useRef(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "permissions") {
          if (msg.cwd === undefined || msg.cwd !== cwdRef.current) return;
          setRules({ cwd: msg.cwd, path: msg.path, allow: msg.allow, deny: msg.deny });
          setBusy(false);
          setError(null);
          if (saving.current) setSavedAt(Date.now());
          saving.current = false;
        } else if (msg.type === "error" && (msg.ref === "permissions.get" || msg.ref === "permissions.set")) {
          setBusy(false);
          saving.current = false;
          setError(msg.message);
        }
      }),
    [conn],
  );

  useEffect(() => {
    setRules(null);
    setError(null);
    if (!cwd || !connected) return;
    try {
      conn.send({ type: "permissions.get", cwd });
    } catch {
      // Not connected. The page shows the note.
    }
  }, [conn, cwd, connected]);

  return {
    rules: rules && rules.cwd === cwd ? rules : null,
    error,
    busy,
    savedAt,
    save: (allow: string[], deny: string[]) => {
      if (!cwd) return;
      setBusy(true);
      setError(null);
      saving.current = true;
      try {
        conn.send({ type: "permissions.set", cwd, allow, deny });
      } catch (e) {
        setBusy(false);
        saving.current = false;
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

export function PermissionRulesSettings({ conn, connected, projects, currentProject }: {
  conn: DaemonConnection;
  connected: boolean;
  projects: ProjectItem[] | null;
  currentProject: string | null; // The project of the open session.
}) {
  const choices = [...(projects ?? [])].sort((a, b) => b.last_used - a.last_used);
  const [project, setProject] = useState<string | null>(null);
  const cwd = project ?? currentProject ?? choices[0]?.path ?? null;
  const projectName = choices.find((p) => p.path === cwd)?.name ?? cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const { rules, error, busy, savedAt, save } = useProjectRules(conn, cwd, connected);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (savedAt === null) return;
    setSaved(true);
    const timer = window.setTimeout(() => setSaved(false), 1500);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  const off = !connected || !rules || busy;

  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Permission rules</h2>
        <span className="settings-status" aria-live="polite">
          {saved ? "Saved" : ""}
        </span>
      </div>
      <p className="help settings-note">
        The rules of a project apply to all its sessions, and to the other agents (Agents). A deny rule has priority over an allow rule. A rule is a tool, or a tool with a pattern: <code>bash(npm test)</code>, <code>edit(src/*)</code>, <code>mcp__github__*</code>. "Always allow" on a permission card adds an allow rule here.
      </p>
      {!connected && <p className="help settings-note">Connect to a computer to see the rules of its projects.</p>}
      <Row label="Project" help="The rules below apply to this project only." htmlFor="setting-rules-project">
        <select id="setting-rules-project" value={cwd ?? ""} disabled={!connected || choices.length === 0} onChange={(e) => setProject(e.target.value)}>
          {choices.length === 0 && <option value="">No projects yet</option>}
          {cwd && !choices.some((p) => p.path === cwd) && <option value={cwd}>{projectName}</option>}
          {choices.map((p) => (
            <option key={p.id} value={p.path} title={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      {rules && <p className="help settings-note rules-path">Saved in <code>{rules.path}</code> of {projectName}.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {connected && cwd && !rules && !error ? (
        <span className="skeleton skeleton-textarea" aria-busy="true" aria-label="Loading the rules" />
      ) : (
        rules && (
          <div className="settings-rules">
            <RuleList kind="allow" rules={rules.allow} busy={off} onChange={(allow) => save(allow, rules.deny)} />
            <RuleList kind="deny" rules={rules.deny} busy={off} onChange={(deny) => save(rules.allow, deny)} />
          </div>
        )
      )}
    </div>
  );
}
