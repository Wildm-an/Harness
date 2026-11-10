// The session search (Ctrl+K), as in Claude: a box at the top of the window, and the sessions whose
// name or folder has the typed text. Up and Down select a session, and Enter opens it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, MessageSquare, Search } from "lucide-react";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { parentHints } from "../lib/projectLabels";
import { groupByProject } from "./Sidebar";

/** The search shows this many sessions. */
const LIMIT = 50;

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function age(seconds: number): string {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return `${Math.floor(diff / 86400)} d`;
}

/**
 * The project name of each session, as the sidebar shows it: the name of a saved project ("Demo app"),
 * with its parent folder when two projects have the same name ("Demo app · scratchpad"). A folder that
 * is not a project shows its folder name (audit C7).
 */
export function projectLabels(sessions: SessionSummary[], projects: ProjectItem[]): Map<string, string> {
  const groups = groupByProject(sessions, projects);
  const hints = parentHints(groups);
  const labels = new Map<string, string>();
  for (const g of groups) {
    const hint = hints.get(g.key);
    for (const s of g.sessions) labels.set(s.id, hint ? `${g.name} · ${hint}` : g.name);
  }
  return labels;
}

/** The sessions that match all words of the query, in the name or the project. Newest first. */
export function searchSessions(sessions: SessionSummary[], query: string, labels?: Map<string, string>): SessionSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sorted = [...sessions].sort((a, b) => b.updated_at - a.updated_at);
  const found = words.length
    ? sorted.filter((s) => {
        const text = `${s.title ?? ""} ${labels?.get(s.id) ?? folderName(s.cwd)}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : sorted;
  return found.slice(0, LIMIT);
}

export function SessionSearch({ sessions, projects = [], activeId, onOpen, onClose }: {
  sessions: SessionSummary[];
  projects?: ProjectItem[]; // The saved projects: the meta line uses their names, as the sidebar does.
  activeId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useOverlay(true);
  const labels = useMemo(() => projectLabels(sessions, projects), [sessions, projects]);
  const found = useMemo(() => searchSessions(sessions, query, labels), [sessions, query, labels]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const open = (s: SessionSummary | undefined) => {
    if (!s) return;
    onClose();
    if (s.id !== activeId) onOpen(s.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (found.length) setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + found.length) % found.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(found[index]);
    }
  };

  return (
    <div className="modal-backdrop session-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal session-search" role="dialog" aria-modal="true" aria-label="Search the sessions" onKeyDown={onKeyDown}>
        <div className="session-search-box">
          <Search size={16} aria-hidden />
          <input
            ref={input}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the sessions"
            aria-label="Search the sessions"
            role="combobox"
            aria-expanded="true"
            aria-controls="session-search-list"
            aria-activedescendant={found[index] ? `session-search-${found[index].id}` : undefined}
            spellCheck={false}
          />
        </div>
        {found.length === 0 ? (
          <p className="session-search-empty">{sessions.length === 0 ? "No sessions yet." : "No session matches."}</p>
        ) : (
          <ul id="session-search-list" ref={list} className="session-search-list" role="listbox" aria-label="Sessions">
            {found.map((s, i) => (
              <li
                key={s.id}
                id={`session-search-${s.id}`}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`session-search-item${i === index ? " selected" : ""}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => open(s)}
              >
                {s.archived ? <Archive size={14} aria-hidden /> : <MessageSquare size={14} aria-hidden />}
                <span className="session-search-title">{s.title ?? "Untitled session"}</span>
                <span className="session-search-meta">
                  {labels.get(s.id) ?? folderName(s.cwd)} · {age(s.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
