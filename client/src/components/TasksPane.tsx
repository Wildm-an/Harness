// The Background tasks pane: the commands that the agent runs in the background (bash with
// run_in_background), with their output. The user can stop a task.

import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleSlash, CircleX, LoaderCircle, Square } from "lucide-react";
import type { TaskDetail, TaskItem } from "../daemon/protocol";

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
  const [now, setNow] = useState(() => Date.now());
  const output = useRef<HTMLPreElement>(null);
  const shown = items?.find((t) => t.id === selected) ?? null;

  useEffect(() => {
    if (items === null) onRequest();
  }, [items === null]);

  // The newest task shows when the user did not select one.
  useEffect(() => {
    if (items && items.length && !items.some((t) => t.id === selected)) setSelected(items[items.length - 1].id);
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
        No background tasks. The agent starts a task when it runs a long command in the background, for example a build or a test run.
      </p>
    );
  }

  const text = detail && detail.id === shown?.id ? detail : null;
  return (
    <div className="tasks-pane">
      <ul className="tasks-list" role="listbox" aria-label="Background tasks">
        {[...items].reverse().map((t) => (
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
              {t.description && <span className="task-command mono">{t.command}</span>}
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
        ))}
      </ul>
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
