// The Background tasks pane: the work that runs in the background, with its output: commands (bash
// with run_in_background), monitors, background agents, and wakeups. The user can stop a task.

import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleSlash, CircleX, LoaderCircle, Square } from "lucide-react";
import type { TaskDetail, TaskItem, TaskKind } from "../daemon/protocol";
import { splitTasks } from "../lib/sessionRail";

const TASK_KINDS: Record<TaskKind, string> = { shell: "Command", monitor: "Monitor", agent: "Agent", wakeup: "Wakeup", cron: "Scheduled" };

function elapsed(task: TaskItem, now: number): string {
  const seconds = Math.max(0, Math.round((task.ended_at ?? now / 1000) - task.started_at));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function StatusIcon({ status }: { status: TaskItem["status"] }) {
  if (status === "running") return <LoaderCircle size={14} className="spin" aria-label="Running" />;
  if (status === "done") return <CircleCheck size={14} className="task-ok" aria-label="Done" />;
  if (status === "stopped") return <CircleSlash size={14} className="task-muted" aria-label="Stopped" />;
  return <CircleX size={14} className="task-failed" aria-label="Failed" />;
}

export function TasksPane({
  items,
  detail,
  onRequest,
  onOpen,
  onStop,
}: {
  items: TaskItem[] | null; // null: not loaded yet.
  detail: TaskDetail | null; // The output of the selected task.
  onRequest: () => void; // Ask the daemon for the list.
  onOpen: (id: string) => void; // Ask the daemon for the output of a task.
  onStop: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [finishedOpen, setFinishedOpen] = useState(false); // The "Finished" group starts folded.
  const [now, setNow] = useState(() => Date.now());
  const output = useRef<HTMLPreElement>(null);
  const shown = items?.find((t) => t.id === selected) ?? null;

  useEffect(() => {
    if (items === null) onRequest();
  }, [items === null]);

  // The newest running task shows when the user did not select one. With no running task: the newest task.
  useEffect(() => {
    if (!items || !items.length || items.some((t) => t.id === selected)) return;
    const { active, finished } = splitTasks(items);
    setSelected((active[0] ?? finished[0]).id);
  }, [items]);

  // The output of the selected task. A running task gets new output each second.
  useEffect(() => {
    if (!shown) return;
    onOpen(shown.id);
    if (shown.status !== "running") return;
    const timer = window.setInterval(() => {
      onOpen(shown.id);
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [shown?.id, shown?.status]);

  // Keep the end of the output in view, as in a terminal.
  useEffect(() => {
    const el = output.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.output.length, detail?.id]);

  if (items === null) {
    return (
      <p className="pane-empty">
        <LoaderCircle size={14} className="spin" aria-hidden /> Loading the tasks.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="pane-empty">
        No background tasks. The agent starts a task when it runs a long command in the background, watches a command with a monitor, gives work to a background agent, sets a wakeup, or schedules a prompt.
      </p>
    );
  }

  const text = detail && detail.id === shown?.id ? detail : null;
  const { active, finished } = splitTasks(items);
  const row = (t: TaskItem) => (
    <li
      key={t.id}
      role="option"
      aria-selected={t.id === selected}
      className={`task-row${t.id === selected ? " active" : ""}`}
      onClick={() => setSelected(t.id)}
    >
      <StatusIcon status={t.status} />
      <span className="task-text">
        <span className="task-title">{t.description || t.command}</span>
        <span className="task-command">
          {TASK_KINDS[t.kind ?? "shell"]}
          {t.description && <span className="mono"> · {t.command.split("\n")[0]}</span>}
        </span>
      </span>
      <span className="task-time">{elapsed(t, now)}</span>
      {t.status === "running" && (
        <button
          type="button"
          className="icon-btn ghost task-stop"
          onClick={(e) => {
            e.stopPropagation();
            onStop(t.id);
          }}
          aria-label={`Stop ${t.description || t.command}`}
          title="Stop"
        >
          <Square size={11} fill="currentColor" aria-hidden />
        </button>
      )}
    </li>
  );
  return (
    <div className="tasks-pane">
      <div className="tasks-list">
        {active.length > 0 && (
          <ul className="tasks-group" role="listbox" aria-label="Active background tasks">
            {active.map(row)}
          </ul>
        )}
        {/* A task that ends goes into the "Finished" group. The group starts folded (the user asked for this). */}
        {finished.length > 0 && (
          <>
            <button
              type="button"
              className={`tasks-finished-head${finishedOpen ? " open" : ""}`}
              aria-expanded={finishedOpen}
              aria-controls="tasks-finished"
              onClick={() => setFinishedOpen((v) => !v)}
            >
              <ChevronRight size={14} aria-hidden className="tasks-finished-chevron" />
              <span>Finished</span>
              <span className="tasks-finished-count">{finished.length}</span>
            </button>
            {finishedOpen && (
              <ul id="tasks-finished" className="tasks-group" role="listbox" aria-label="Finished background tasks">
                {finished.map(row)}
              </ul>
            )}
          </>
        )}
      </div>
      {shown && (
        <div className="task-output-wrap">
          <div className="task-output-head">
            <span className="mono">{shown.id}</span>
            <span className="task-status">
              {shown.status === "running"
                ? "Running"
                : shown.status === "stopped"
                  ? "Stopped"
                  : `Exit code ${shown.returncode}`}
            </span>
          </div>
          <pre className="task-output mono" ref={output}>
            {text ? (text.dropped ? `[${text.dropped} earlier characters are not kept.]\n` : "") + (text.output || "(no output yet)") : "Loading the output."}
          </pre>
        </div>
      )}
    </div>
  );
}
