// The ⋮ menu at the right of the title bar, as in Claude: the Files pane, the Background tasks pane,
// and the "Keep computer awake" switch of the session.

import { useEffect, useRef, useState } from "react";
import { EllipsisVertical, Files, ListChecks } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export function MoreMenu({
  filesKey,
  filesOpen,
  onFiles,
  runningTasks,
  onTasks,
  keepAwake,
  onKeepAwake,
  disabled,
}: {
  filesKey: string; // "Ctrl+Shift+F".
  filesOpen: boolean;
  onFiles: () => void;
  runningTasks: number;
  onTasks: () => void;
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
        {runningTasks > 0 && <span className="toggle-alert" aria-hidden />}
      </button>
      {open && (
        <div className="menu more-dropdown" role="menu" aria-label="More" data-tauri-drag-region="false">
          <button type="button" role="menuitemcheckbox" aria-checked={filesOpen} onClick={() => run(onFiles)}>
            <Files size={15} aria-hidden />
            <span className="more-label">Files</span>
            <span className="more-key">{filesKey}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onTasks)}>
            <ListChecks size={15} aria-hidden />
            <span className="more-label">Background tasks</span>
            {runningTasks > 0 && <span className="more-count" aria-label={`${runningTasks} running`}>{runningTasks}</span>}
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
