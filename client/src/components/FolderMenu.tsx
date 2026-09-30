// The folder chip in the top bar of a session, with a menu as in Claude: Show in Explorer, Copy path,
// Change folder, and Open in terminal.

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Folder, FolderInput, FolderOpen, SquareTerminal } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export function FolderMenu({ name, path, canReveal, canChange, onReveal, onChange, onOpenTerminal }: {
  name: string;
  path: string;
  canReveal: boolean; // Only for the daemon on this computer, in the desktop app.
  canChange: boolean; // Not during a turn.
  onReveal: () => void;
  onChange: () => void;
  onOpenTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // The title area of the top bar hides its overflow: the menu has a fixed position in the window.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  useOverlay(open);

  const toggle = () => {
    if (!open && chip.current) {
      const r = chip.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 216)) });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    // preventScroll: the focus must not scroll the title area, which hides its overflow.
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 700);
    } catch {
      setOpen(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  return (
    <div className="folder-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        ref={chip}
        type="button"
        className={`chip mono folder-chip${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={path}
        onClick={toggle}
      >
        <Folder size={12} aria-hidden />
        {name}
      </button>
      {open && (
        <div className="menu folder-dropdown" role="menu" aria-label={`The folder ${name}`} style={pos ?? undefined}>
          <button
            type="button"
            role="menuitem"
            disabled={!canReveal}
            title={canReveal ? path : "Only for the daemon on this computer, in the desktop app."}
            onClick={() => run(onReveal)}
          >
            <FolderOpen size={14} aria-hidden /> Show in Explorer
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy path"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canChange}
            title={canChange ? "Move the session to another folder. The history stays." : "Stop the turn first."}
            onClick={() => run(onChange)}
          >
            <FolderInput size={14} aria-hidden /> Change folder…
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => run(onOpenTerminal)}>
            <SquareTerminal size={14} aria-hidden /> Open in terminal
          </button>
        </div>
      )}
    </div>
  );
}
