// The ⋮ menu at the right of the title bar, as in Claude: the side chat, the IDE view, the Background tasks pane,
// the Preview pane (PDF and Word files), and the "Keep computer awake" switch of the session.
// Files is a pane button in the title bar (docs/UI_RULES.md V1).

import { useEffect, useRef, useState } from "react";
import { Check, Code2, EllipsisVertical, FileText, ListChecks, MessagesSquare } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export function MoreMenu({
  sideChatKey,
  sideChatOpen,
  onSideChat,
  ideKey,
  ideOpen,
  onIde,
  runningTasks,
  onTasks,
  previewOpen,
  onPreview,
  keepAwake,
  onKeepAwake,
  disabled,
}: {
  sideChatKey: string; // "Ctrl+;".
  sideChatOpen: boolean;
  onSideChat: () => void;
  ideKey: string; // "Ctrl+E".
  ideOpen: boolean; // The IDE view shows. Off: the Code view.
  onIde: () => void;
  runningTasks: number;
  onTasks: () => void;
  previewOpen: boolean;
  onPreview: () => void;
  keepAwake: boolean;
  onKeepAwake: (on: boolean) => void;
  disabled: boolean; // Not connected.
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  return (
    <div className="more-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`icon-btn ghost pane-toggle${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
        onClick={() => setOpen((v) => !v)}
      >
        <EllipsisVertical size={16} aria-hidden />
        {/* Tasks run: an accent dot. Red means a failure in the rest of the app (audit C8). */}
        {runningTasks > 0 && <span className="toggle-alert busy" aria-hidden />}
      </button>
      {open && (
        <div className="menu more-dropdown" role="menu" aria-label="More" data-tauri-drag-region="false">
          <button type="button" role="menuitemcheckbox" aria-checked={sideChatOpen} onClick={() => run(onSideChat)}>
            <MessagesSquare size={15} aria-hidden />
            <span className="more-label">Side chat</span>
            {sideChatOpen && <Check size={14} aria-hidden />}
            <span className="more-key">{sideChatKey}</span>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={ideOpen} onClick={() => run(onIde)}>
            <Code2 size={15} aria-hidden />
            <span className="more-label">IDE view</span>
            {ideOpen && <Check size={14} aria-hidden />}
            <span className="more-key">{ideKey}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onTasks)}>
            <ListChecks size={15} aria-hidden />
            <span className="more-label">Background tasks</span>
            {runningTasks > 0 && <span className="more-count" aria-label={`${runningTasks} running`}>{runningTasks}</span>}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={previewOpen} onClick={() => run(onPreview)}>
            <FileText size={15} aria-hidden />
            <span className="more-label">Preview</span>
            {previewOpen && <Check size={14} aria-hidden />}
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={keepAwake}
            className="more-awake"
            disabled={disabled}
            onClick={() => onKeepAwake(!keepAwake)}
            title="The computer of the agent does not sleep while the agent works in this session."
          >
            <span className="more-awake-text">
              <span>Keep computer awake</span>
              <span className="more-awake-sub">Only for this session</span>
            </span>
            <span className={`switch${keepAwake ? " on" : ""}`} aria-hidden>
              <span className="switch-knob" />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
