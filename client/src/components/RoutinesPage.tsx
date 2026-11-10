// The Routines page (docs/UI_RULES.md section 3.5): prompts that the daemon runs on a schedule, each
// in a new session. The daemon keeps the routines and runs them also when no window is open.

import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Copy,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { PermissionMode, ProjectItem, RoutineFields, RoutineItem, RoutineRun, RoutineRunStatus } from "../daemon/protocol";
import { ConfirmDialog, useConfirm } from "./ConfirmDialog";
import { ModeMenu } from "./ModeMenu";
import { ModelMenu, type ModelList } from "./ModelMenu";
import { Switch } from "./ProvidersScreen";

// -- the schedule ---------------------------------------------------------------------------------

export type ScheduleKind = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

/** The schedule as the form shows it. "custom": the cron text. */
export interface ScheduleChoice {
  kind: ScheduleKind;
  minute: number;
  hour: number;
  day: number; // 0 is Sunday (weekly).
  cron: string;
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const KINDS: [ScheduleKind, string][] = [
  ["hourly", "Hourly"],
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["custom", "Custom (cron)"],
];

const pad = (n: number) => String(n).padStart(2, "0");

export function scheduleToCron(c: ScheduleChoice): string {
  switch (c.kind) {
    case "hourly":
      return `${c.minute} * * * *`;
    case "daily":
      return `${c.minute} ${c.hour} * * *`;
    case "weekdays":
      return `${c.minute} ${c.hour} * * 1-5`;
    case "weekly":
      return `${c.minute} ${c.hour} * * ${c.day}`;
    case "custom":
      return c.cron.trim().split(/\s+/).join(" ");
  }
}

/** The form choice of a cron expression. An expression that no preset makes is "custom". */
export function cronToSchedule(cron: string): ScheduleChoice {
  const text = cron.trim().split(/\s+/).join(" ");
  const custom: ScheduleChoice = { kind: "custom", minute: 0, hour: 9, day: 1, cron: text };
  const f = text.split(" ");
  if (f.length !== 5) return custom;
  const [mi, h, dom, mon, dow] = f;
  const num = (v: string, max: number) => (/^\d+$/.test(v) && Number(v) <= max ? Number(v) : null);
  const minute = num(mi, 59);
  if (minute === null || dom !== "*" || mon !== "*") return custom;
  if (h === "*") return dow === "*" ? { ...custom, kind: "hourly", minute } : custom;
  const hour = num(h, 23);
  if (hour === null) return custom;
  if (dow === "*") return { ...custom, kind: "daily", minute, hour };
  if (dow === "1-5") return { ...custom, kind: "weekdays", minute, hour };
  const day = num(dow, 7);
  return day === null ? custom : { ...custom, kind: "weekly", minute, hour, day: day % 7 };
}

/** The schedule in words, for the list rows: "Every weekday at 09:00". */
export function describeSchedule(cron: string): string {
  const c = cronToSchedule(cron);
  const time = `${pad(c.hour)}:${pad(c.minute)}`;
  switch (c.kind) {
    case "hourly":
      return c.minute === 0 ? "Every hour" : `Every hour at :${pad(c.minute)}`;
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Every weekday at ${time}`;
    case "weekly":
      return `Every ${DAYS[c.day]} at ${time}`;
    case "custom":
      return `Cron: ${c.cron}`;
  }
}

/** A time for the rows: "Today at 09:00", "Tomorrow at 09:00", or the date. */
export function formatWhen(epoch: number, now: number = Date.now() / 1000): string {
  const d = new Date(epoch * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now * 1000))) / 86_400_000);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Tomorrow at ${time}`;
  if (diff === -1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

// -- the state of a routine -----------------------------------------------------------------------

/** "active": the routine runs at the times of its schedule. "inactive": it is off, or its file has a problem. */
export type Activity = "active" | "inactive";

export function activity(item: RoutineItem): Activity {
  return item.enabled && !item.error ? "active" : "inactive";
}

/** What happens with the routine now, next to its Active or Inactive label. null: nothing to show. */
export type RunState = "file_error" | "queued" | "running" | "waiting" | "failed";

export function runState(item: RoutineItem): RunState | null {
  if (item.error) return "file_error";
  if (item.last_run?.status === "waiting") return "waiting";
  if (item.running) return "running";
  if (item.queued) return "queued";
  if (item.last_run?.status === "failed") return "failed";
  return null;
}

type Tone = "ok" | "busy" | "bad" | "off" | "warn";
type PillInfo = { label: string; tone: Tone; icon: LucideIcon; tip: string };

const ACTIVITY: Record<Activity, PillInfo> = {
  active: { label: "Active", tone: "ok", icon: CircleCheck, tip: "The routine runs at the times of its schedule." },
  inactive: { label: "Inactive", tone: "off", icon: CircleSlash, tip: "The routine does not run on its schedule. Run now still runs it." },
};

const RUN_STATES: Record<RunState, PillInfo> = {
  file_error: { label: "File error", tone: "bad", icon: CircleX, tip: "The file of the routine has a problem. Open the routine to see it." },
  queued: { label: "Waiting", tone: "busy", icon: Clock, tip: "Other routines run now. This routine starts when one of them ends." },
  running: { label: "Running", tone: "busy", icon: LoaderCircle, tip: "The routine runs now in a new session." },
  waiting: { label: "Needs approval", tone: "warn", icon: ShieldAlert, tip: "The run waits for a permission answer. Open its session to answer." },
  failed: { label: "Last run failed", tone: "bad", icon: CircleX, tip: "The last run did not end correctly. Open the routine to see the error." },
};

/** The Active or Inactive label, and the run state if there is one. */
function StatePills({ item }: { item: RoutineItem }) {
  const run = runState(item);
  return (
    <span className="routine-pills">
      <Pill {...ACTIVITY[activity(item)]} />
      {run && <Pill {...RUN_STATES[run]} spin={run === "running"} />}
    </span>
  );
}

const RUNS: Record<RoutineRunStatus, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "busy" },
  waiting: { label: "Needs approval", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  skipped: { label: "Skipped", tone: "off" },
};

function Pill({ label, tone, icon: Icon, tip, spin }: { label: string; tone: Tone; icon?: LucideIcon; tip?: string; spin?: boolean }) {
  return (
    <span className={`cap-status cap-${tone}`} title={tip}>
      {Icon && <Icon size={13} aria-hidden className={spin ? "spin" : undefined} />}
      {label}
    </span>
  );
}

// -- the form -------------------------------------------------------------------------------------

export interface RoutineDraft {
  name: string;
  prompt: string;
  cwd: string;
  model: string; // "" is the default model.
  permission_mode: PermissionMode;
  schedule: ScheduleChoice;
  enabled: boolean;
}

export type DraftErrors = Partial<Record<"name" | "prompt" | "cwd" | "schedule", string>>;

export function newDraft(projects: ProjectItem[]): RoutineDraft {
  return {
    name: "",
    prompt: "",
    cwd: projects.find((p) => p.exists)?.path ?? "",
    model: "",
    permission_mode: "default",
    schedule: cronToSchedule("0 9 * * 1-5"),
    enabled: true,
  };
}

export function draftOf(item: RoutineItem): RoutineDraft {
  return {
    name: item.name,
    prompt: item.prompt,
    cwd: item.cwd,
    model: item.model ?? "",
    permission_mode: item.permission_mode,
    schedule: cronToSchedule(item.schedule),
    enabled: item.enabled,
  };
}

/** The errors of the form. The daemon checks the cron expression again. */
export function checkDraft(d: RoutineDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.name.trim()) errors.name = "Enter a name.";
  if (!d.prompt.trim()) errors.prompt = "Enter the prompt.";
  if (!d.cwd.trim()) errors.cwd = "Choose a folder.";
  if (d.schedule.kind === "custom" && scheduleToCron(d.schedule).split(" ").length !== 5) {
    errors.schedule = "A cron expression has 5 fields, for example 0 9 * * 1-5.";
  }
  return errors;
}

export function fieldsOf(d: RoutineDraft): RoutineFields {
  return {
    name: d.name.trim(),
    prompt: d.prompt.trim(),
    cwd: d.cwd.trim(),
    model: d.model || null,
    permission_mode: d.permission_mode,
    schedule: scheduleToCron(d.schedule),
    enabled: d.enabled,
  };
}

/** The path of the file of a routine: the folder, and the id with ".md". */
export function routineFile(folder: string, id: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${id}.md`;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function ScheduleFields({ value, error, onChange }: { value: ScheduleChoice; error?: string; onChange: (next: ScheduleChoice) => void }) {
  const time = `${pad(value.hour)}:${pad(value.minute)}`;
  const setTime = (text: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (m) onChange({ ...value, hour: Math.min(Number(m[1]), 23), minute: Math.min(Number(m[2]), 59) });
  };
  return (
    <div className="field">
      <label htmlFor="rt-kind">Schedule</label>
      <div className="routine-schedule">
        <select
          id="rt-kind"
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as ScheduleKind;
            // A change to "Custom" starts from the cron text of the old choice.
            onChange({ ...value, kind, cron: kind === "custom" ? scheduleToCron(value) : value.cron });
          }}
        >
          {KINDS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {value.kind === "weekly" && (
          <select aria-label="Day" value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })}>
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        )}
        {value.kind === "hourly" && (
          <label className="routine-inline">
            at minute
            <input
              type="number"
              min={0}
              max={59}
              value={value.minute}
              onChange={(e) => onChange({ ...value, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })}
            />
          </label>
        )}
        {(value.kind === "daily" || value.kind === "weekdays" || value.kind === "weekly") && (
          <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
        )}
        {value.kind === "custom" && (
          <input
            className="mono"
            aria-label="Cron expression"
            value={value.cron}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(e) => onChange({ ...value, cron: e.target.value })}
          />
        )}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="help">
          {value.kind === "custom"
            ? "5 fields in the local time of the daemon computer: minute, hour, day of the month, month, day of the week."
            : `${describeSchedule(scheduleToCron(value))}, in the local time of the daemon computer.`}
        </p>
      )}
    </div>
  );
}

function RunList({ runs, onOpenSession }: { runs: RoutineRun[] | null; onOpenSession: (id: string) => void }) {
  if (runs === null) {
    return (
      <p className="cap-empty">
        <LoaderCircle size={14} className="spin" aria-hidden /> Loading the runs.
      </p>
    );
  }
  if (runs.length === 0) return <p className="cap-empty">No runs yet.</p>;
  return (
    <ul className="cap-list routine-runs">
      {runs.map((run) => {
        const s = RUNS[run.status];
        return (
          <li key={run.id} className="cap-item routine-run">
            <span className="cap-text">
              <span className="cap-name">{formatWhen(run.started_at)}</span>
              {run.error && <span className="cap-desc">{run.error}</span>}
            </span>
            <Pill label={s.label} tone={s.tone} spin={run.status === "running"} />
            {run.session_id && (
              <button type="button" className="btn btn-small" onClick={() => onOpenSession(run.session_id as string)}>
                Open session
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RoutineForm({
  item,
  file,
  draft: initial,
  runs,
  projects,
  models,
  saving,
  error,
  onRequestModels,
  onManageProviders,
  onBrowse,
  onSave,
  onDelete,
  onRun,
  onOpenSession,
  onBack,
  api = null,
}: {
  item: RoutineItem | null; // null: a new routine.
  file: string | null; // The path of the routine file on the daemon computer.
  draft: RoutineDraft;
  runs: RoutineRun[] | null;
  projects: ProjectItem[];
  models: ModelList | null;
  saving: boolean;
  error: string | null;
  onRequestModels: () => void;
  onManageProviders: () => void;
  onBrowse: (initial: string) => Promise<string | null>;
  onSave: (fields: RoutineFields) => void;
  onDelete: () => void;
  onRun: () => void;
  onOpenSession: (id: string) => void;
  onBack: () => void;
  api?: ApiProps | null; // The API trigger of a saved routine.
}) {
  const [d, setD] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [confirm, setConfirm] = useState(false);
  const update = (patch: Partial<RoutineDraft>) => setD((old) => ({ ...old, ...patch }));
  const folders = projects.filter((p) => p.exists).map((p) => p.path);
  if (d.cwd && !folders.includes(d.cwd)) folders.unshift(d.cwd);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = checkDraft(d);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(fieldsOf(d));
  };

  return (
    <div className="routine-view">
      <button type="button" className="btn btn-small cap-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden />
        All routines
      </button>
      <div className="cap-view-head">
        <h2>{item ? item.name : "New routine"}</h2>
        {item && <StatePills item={item} />}
      </div>
      {item && (
        <div className="routine-actions">
          <button type="button" className="btn btn-small" onClick={onRun} disabled={item.running || item.queued || !!item.error}>
            <Play size={14} aria-hidden />
            Run now
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirm(true)}>
            <Trash2 size={14} aria-hidden />
            Delete…
          </button>
          {item.next_fire_at && <span className="help">Next run: {formatWhen(item.next_fire_at)}</span>}
        </div>
      )}
      {item && file && <p className="help mono routine-file">{file}</p>}
      {item?.error && (
        <p className="form-error" role="alert">
          The file has a problem: {item.error} Save the form to write the file again, or edit the file.
        </p>
      )}
      <form className="routine-form" onSubmit={submit} noValidate autoComplete="off">
        <div className="field">
          <label htmlFor="rt-name">Name</label>
          <input id="rt-name" value={d.name} placeholder="Daily summary" onChange={(e) => update({ name: e.target.value })} aria-invalid={!!errors.name} />
          {errors.name && (
            <p className="field-error" role="alert">
              {errors.name}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="rt-prompt">Prompt</label>
          <textarea
            id="rt-prompt"
            rows={5}
            value={d.prompt}
            placeholder="Summarize the commits of the last day and list the open problems."
            onChange={(e) => update({ prompt: e.target.value })}
            aria-invalid={!!errors.prompt}
          />
          {errors.prompt ? (
            <p className="field-error" role="alert">
              {errors.prompt}
            </p>
          ) : (
            <p className="help">Each run starts a new session with this prompt.</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="rt-folder">Folder</label>
          <div className="field-row">
            <select id="rt-folder" value={d.cwd} onChange={(e) => update({ cwd: e.target.value })} aria-invalid={!!errors.cwd}>
              {folders.length === 0 && <option value="">No folder</option>}
              {folders.map((path) => (
                <option key={path} value={path} title={path}>
                  {folderName(path)}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void onBrowse(d.cwd).then((path) => path && update({ cwd: path }))}>
              <FolderOpen size={14} aria-hidden />
              Choose…
            </button>
          </div>
          {errors.cwd ? (
            <p className="field-error" role="alert">
              {errors.cwd}
            </p>
          ) : (
            d.cwd && <p className="help mono">{d.cwd}</p>
          )}
        </div>
        <div className="field routine-chips">
          <span className="field-label">Model and permission mode</span>
          <div className="routine-chip-row">
            <ModelMenu
              value={d.model}
              models={models}
              allowDefault
              onOpen={onRequestModels}
              onSelect={(spec) => update({ model: spec })}
              onManage={onManageProviders}
            />
            <ModeMenu mode={d.permission_mode} onChange={(mode) => update({ permission_mode: mode })} up={false} />
          </div>
          <p className="help">
            No one can answer a permission request while no window shows the session. In Manual mode, a run waits: open its session to answer.
          </p>
        </div>
        <ScheduleFields value={d.schedule} error={errors.schedule} onChange={(schedule) => update({ schedule })} />
        <div className="field routine-enabled">
          <span className="field-label">Run on the schedule</span>
          <Switch checked={d.enabled} label="Run on the schedule" onChange={(enabled) => update({ enabled })} />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onBack}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving && <LoaderCircle size={14} className="spin" aria-hidden />}
            {item ? "Save" : "Create routine"}
          </button>
        </div>
      </form>
      {item && api && <ApiAccess item={item} api={api} />}
      {!item && <p className="help">Save the routine to add an API trigger: your own code can then start a run with a POST request.</p>}
      {item && (
        <section className="cap-section" aria-labelledby="rt-runs">
          <div className="cap-section-head">
            <h2 id="rt-runs">Runs</h2>
          </div>
          <RunList runs={runs} onOpenSession={onOpenSession} />
        </section>
      )}
      {confirm && item && (
        <ConfirmDialog
          title="Delete this routine?"
          confirmLabel="Delete"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onDelete();
          }}
        >
          The routine {item.name} and its run history go away. The sessions of its runs stay.
        </ConfirmDialog>
      )}
    </div>
  );
}

interface ApiProps {
  base: string | null; // http://host:port of the daemon.
  token: string | null; // A new token, shown one time.
  onToken: (action: "generate" | "delete") => void;
  onDone: () => void;
}

/** The fire URL of the API trigger of a routine. */
export function fireUrl(base: string, id: string): string {
  return `${base}/routines/${encodeURIComponent(id)}/fire`;
}

/** The example request of the API trigger, as in the Claude app. */
export function curlExample(url: string): string {
  return [
    `curl -X POST ${url} \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"text": "optional extra text after the prompt"}'`,
  ].join("\n");
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** "API access" of a routine, as the API trigger of the Claude app: the fire URL, the token, and an example request. */
function ApiAccess({ item, api }: { item: RoutineItem; api: ApiProps }) {
  const active = !!item.api?.active;
  const confirm = useConfirm();
  const url = api.base ? fireUrl(api.base, item.id) : null;
  return (
    <section className="cap-section routine-api" aria-labelledby="rt-api">
      <div className="cap-section-head">
        <h2 id="rt-api">API access</h2>
        <span className={`routine-api-status${active ? " active" : ""}`}>{active ? "Active" : "Inactive"}</span>
      </div>
      <p className="help">Trigger from your own code by sending a POST request. The text of the request goes after the prompt of the run.</p>
      <div className="field">
        <label htmlFor="rt-fire-url">Fire URL</label>
        <div className="field-row">
          <input id="rt-fire-url" className="mono" readOnly value={url ?? "Connect to a computer to see the URL."} onFocus={(e) => e.currentTarget.select()} />
          {url && <CopyButton text={url} label="Copy" />}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Token</span>
        {api.token ? (
          <div className="routine-api-token" role="status">
            <strong>Token generated</strong>
            <div className="field-row">
              <input className="mono" readOnly value={api.token} aria-label="The new token" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={api.token} label="Copy token" />
            </div>
            <p className="help">Copy this token now. It is not shown again. Use it as the Bearer credential.</p>
            <button type="button" className="btn btn-small" onClick={api.onDone}>
              Done
            </button>
          </div>
        ) : (
          <p className="help">{active ? `The token ends with ${item.api?.hint ?? "····"}.` : "Generate a token to activate API access."}</p>
        )}
        <div className="routine-actions">
          {active ? (
            <>
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  confirm.ask({
                    title: "Regenerate the token?",
                    text: "The current token stops working at once. Code that uses it fails until it gets the new token.",
                    confirmLabel: "Regenerate",
                    onConfirm: () => api.onToken("generate"),
                  })
                }
              >
                <RefreshCw size={14} aria-hidden />
                Regenerate
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() =>
                  confirm.ask({
                    title: "Delete the token?",
                    text: "The token stops working, and API access of this routine turns off. Its other triggers do not change.",
                    confirmLabel: "Delete",
                    onConfirm: () => api.onToken("delete"),
                  })
                }
              >
                <Trash2 size={14} aria-hidden />
                Delete token
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-small btn-primary" onClick={() => api.onToken("generate")}>
              <KeyRound size={14} aria-hidden />
              Generate token
            </button>
          )}
        </div>
        {active && <p className="help">Regenerating makes the previous token stop working. Delete the token to turn off API access.</p>}
      </div>
      {url && (
        <div className="field">
          <span className="field-label">Example request</span>
          <pre className="tool-pre routine-api-curl">{curlExample(url)}</pre>
          <div className="routine-actions">
            <CopyButton text={curlExample(url)} label="Copy curl" />
          </div>
        </div>
      )}
      {confirm.dialog}
    </section>
  );
}

function RoutineRow({ item, onOpen, onToggle }: { item: RoutineItem; onOpen: () => void; onToggle: (enabled: boolean) => void }) {
  const next = item.next_fire_at ? ` · Next: ${formatWhen(item.next_fire_at)}` : "";
  return (
    <li className="cap-item routine-item">
      <button type="button" className="cap-row" onClick={onOpen}>
        <span className="cap-icon" aria-hidden>
          <CalendarClock size={15} />
        </span>
        <span className="cap-text">
          <span className="cap-name">{item.name}</span>
          <span className="cap-desc">
            {item.error ? `${item.id}.md: ${item.error}` : `${describeSchedule(item.schedule)}${next} · ${folderName(item.cwd)}`}
          </span>
        </span>
        <StatePills item={item} />
        <ChevronRight size={14} aria-hidden className="cap-go" />
      </button>
      <Switch checked={item.enabled} label={`The routine ${item.name} runs on its schedule`} onChange={onToggle} />
    </li>
  );
}

export const RoutinesPage = memo(function RoutinesPage({
  routines,
  folder,
  runs,
  projects,
  models,
  error,
  saved,
  onRequestModels,
  onManageProviders,
  onBrowse,
  onSave,
  onDelete,
  onRun,
  onToggle,
  onRequestRuns,
  onOpenSession,
  apiBase = null,
  newToken = null,
  onToken,
  onTokenDone,
}: {
  routines: RoutineItem[] | null; // null: loading.
  folder: string | null; // The folder of the routine files on the daemon computer (~/.harness/routines).
  runs: { routine_id: string; items: RoutineRun[] } | null;
  projects: ProjectItem[];
  models: ModelList | null;
  error: string | null; // The last error of routines.save.
  saved: { id: string; key: number } | null; // The last routines.save that the daemon did.
  onRequestModels: () => void;
  onManageProviders: () => void;
  onBrowse: (initial: string) => Promise<string | null>;
  onSave: (fields: RoutineFields, id?: string) => void;
  onDelete: (id: string) => void;
  onRun: (id: string) => void;
  onToggle: (item: RoutineItem, enabled: boolean) => void;
  onRequestRuns: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  apiBase?: string | null; // http://host:port of the daemon. null: not connected.
  newToken?: { id: string; token: string } | null; // A new API token, shown one time.
  onToken?: (id: string, action: "generate" | "delete") => void;
  onTokenDone?: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null); // "new": the form of a new routine.
  const [saving, setSaving] = useState(false);
  const savedKey = useRef(saved?.key ?? 0);
  const item = openId && openId !== "new" ? (routines?.find((r) => r.id === openId) ?? null) : null;

  // A save ended: show the routine. A new routine gets its id here.
  useEffect(() => {
    if (!saved || saved.key === savedKey.current) return;
    savedKey.current = saved.key;
    if (saving) {
      setSaving(false);
      setOpenId(saved.id);
    }
  }, [saved, saving]);
  useEffect(() => {
    if (error) setSaving(false);
  }, [error]);
  // The run history of the open routine. A new list (a run started or ended) loads it again.
  useEffect(() => {
    if (item) onRequestRuns(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.last_run?.id, item?.last_run?.status]);
  // The open routine was deleted (also in another window).
  useEffect(() => {
    if (openId && openId !== "new" && routines && !item) setOpenId(null);
  }, [openId, routines, item]);

  let body: React.ReactNode;
  if (openId !== null && (openId === "new" || item)) {
    body = (
      <RoutineForm
        key={openId}
        item={item}
        file={item && folder ? routineFile(folder, item.id) : null}
        draft={item ? draftOf(item) : newDraft(projects)}
        runs={item && runs?.routine_id === item.id ? runs.items : null}
        projects={projects}
        models={models}
        saving={saving}
        error={error}
        onRequestModels={onRequestModels}
        onManageProviders={onManageProviders}
        onBrowse={onBrowse}
        onSave={(fields) => {
          setSaving(true);
          onSave(fields, item?.id);
        }}
        onDelete={() => {
          if (item) onDelete(item.id);
          setOpenId(null);
        }}
        onRun={() => item && onRun(item.id)}
        onOpenSession={onOpenSession}
        onBack={() => setOpenId(null)}
        api={
          item && onToken
            ? {
                base: apiBase,
                token: newToken?.id === item.id ? newToken.token : null,
                onToken: (action) => onToken(item.id, action),
                onDone: () => onTokenDone?.(),
              }
            : null
        }
      />
    );
  } else {
    body = (
      <section className="cap-section" aria-labelledby="rt-list">
        <div className="cap-section-head">
          <h2 id="rt-list">Routines</h2>
          {routines && routines.length > 0 && <span className="cap-count">{routines.length}</span>}
          <span className="cap-section-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={() => setOpenId("new")}>
              <Plus size={14} aria-hidden />
              New routine
            </button>
          </span>
        </div>
        {routines === null ? (
          <p className="cap-empty">
            <LoaderCircle size={14} className="spin" aria-hidden /> Loading the routines.
          </p>
        ) : routines.length === 0 ? (
          <p className="cap-empty">No routines yet. A routine runs a prompt on a schedule, for example a summary of the changes each morning.</p>
        ) : (
          <ul className="cap-list">
            {routines.map((r) => (
              <RoutineRow key={r.id} item={r} onOpen={() => setOpenId(r.id)} onToggle={(enabled) => onToggle(r, enabled)} />
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <div className="cap-page">
      <div className="cap-page-inner">
        <header className="cap-page-head">
          <h1 id="routines-title">Routines</h1>
          <p className="help">
            Prompts that Harness runs on a schedule, each in a new session. Routines run while Harness runs, also with no open window.
            {folder && (
              <>
                {" "}
                Each routine is a file in <span className="mono">{folder}</span>.
              </>
            )}
          </p>
        </header>
        <div role="region" aria-labelledby="routines-title">
          {body}
        </div>
      </div>
    </div>
  );
});
