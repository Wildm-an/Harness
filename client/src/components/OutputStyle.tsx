// Settings > Your Harness > "Output style": how the agent structures its replies, as "Output style" of the Claude
// app. The select lists the built-in styles and the custom styles of the daemon (output_styles.py), then "New output
// style…" at the bottom. That item opens "New output style": the user describes the style, and a model drafts it.

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { OutputStyleItem } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";

export const NEW_STYLE = "__new__"; // The value of "New output style…" in the select.

/** The output styles of the daemon, and the request for a new style. */
export function useOutputStyles(conn: DaemonConnection, connected: boolean) {
  const [items, setItems] = useState<OutputStyleItem[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; note: string | null; key: number } | null>(null);

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "output_styles") {
          setItems(msg.items);
          setFolder(msg.folder);
          if (msg.created) {
            const id = msg.created;
            setCreating(false);
            setCreated((c) => ({ id, note: msg.note ?? null, key: (c?.key ?? 0) + 1 }));
          }
        } else if (msg.type === "error" && msg.ref?.startsWith("output_styles.")) {
          setCreating(false);
          setError(msg.message);
        }
      }),
    [conn],
  );

  useEffect(() => {
    if (!connected) return;
    try {
      conn.send({ type: "output_styles.list" });
    } catch {
      // Not connected. The page shows the note.
    }
  }, [conn, connected]);

  return {
    items,
    folder,
    creating,
    error,
    created,
    clearError: () => setError(null),
    create: (description: string, name: string) => {
      setError(null);
      setCreating(true);
      try {
        conn.send({ type: "output_styles.create", description, name });
      } catch (e) {
        setCreating(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/** The select of the "Output style" row. */
export function OutputStyleSelect({ id, value, items, disabled, onChange, onNew }: {
  id: string;
  value: string;
  items: OutputStyleItem[] | null;
  disabled: boolean;
  onChange: (styleId: string) => void;
  onNew: () => void;
}) {
  const builtIn = (items ?? []).filter((s) => !s.custom);
  const custom = (items ?? []).filter((s) => s.custom);
  const known = (items ?? []).some((s) => s.id === value);
  return (
    <select
      id={id}
      value={value}
      disabled={disabled || items === null}
      title={(items ?? []).find((s) => s.id === value)?.description}
      onChange={(e) => (e.target.value === NEW_STYLE ? onNew() : onChange(e.target.value))}
    >
      {!known && <option value={value}>{items === null ? "Loading…" : value}</option>}
      {builtIn.map((s) => (
        <option key={s.id} value={s.id} title={s.description}>
          {s.name}
        </option>
      ))}
      {custom.length > 0 && (
        <optgroup label="Your styles">
          {custom.map((s) => (
            <option key={s.id} value={s.id} title={s.description}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
      <option disabled>──────────</option>
      <option value={NEW_STYLE}>New output style…</option>
    </select>
  );
}

/** "New output style": the description, an optional name, "Cancel", and "Create style". */
export function NewOutputStyleDialog({ busy, error, onCreate, onClose }: {
  busy: boolean;
  error: string | null;
  onCreate: (description: string, name: string) => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useOverlay(true);
  useEffect(() => area.current?.focus(), []);
  const ready = description.trim().length > 0 && !busy;
  const submit = () => ready && onCreate(description.trim(), name.trim());

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="modal new-style-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-style-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="new-style-head">
          <h2 id="new-style-title">New output style</h2>
          <button type="button" className="icon-btn ghost" onClick={onClose} disabled={busy} aria-label="Close" title="Close">
            <X size={16} aria-hidden />
          </button>
        </header>
        <form
          className="new-style-body"
          noValidate
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="help">Describe the style, and the agent will draft it for you.</p>
          <div className="field">
            <label htmlFor="new-style-description">What should the style be like?</label>
            <textarea
              id="new-style-description"
              ref={area}
              className="setting-textarea"
              rows={4}
              maxLength={2000}
              value={description}
              placeholder="Short answers first, then detail. No filler words."
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="new-style-name">Name (optional)</label>
            <input id="new-style-name" value={name} maxLength={40} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <span className="spacer" />
            <button type="button" className="btn btn-small" onClick={onClose} disabled={busy} data-form-cancel>
              Cancel
            </button>
            <button type="submit" className="btn btn-small btn-primary" disabled={!ready}>
              {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
              {busy ? "Drafting…" : "Create style"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
