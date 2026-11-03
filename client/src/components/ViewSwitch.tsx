// The view switch in the session title bar: "</>" is the Code view (the chat first), and "IDE" is
// the IDE view (the editor first, as in Cursor). It is a radio group: the arrow keys move the choice.

import { useRef, type KeyboardEvent } from "react";
import { Code2 } from "lucide-react";
import type { ViewMode } from "../lib/viewMode";

const VIEWS: { mode: ViewMode; label: string }[] = [
  { mode: "code", label: "Code view" },
  { mode: "ide", label: "IDE view" },
];

export function ViewSwitch({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = VIEWS[e.key === "ArrowLeft" ? 0 : 1];
    onChange(next.mode);
    refs.current[e.key === "ArrowLeft" ? 0 : 1]?.focus();
  };
  return (
    <div className="view-switch" role="radiogroup" aria-label="View" onKeyDown={onKeyDown}>
      {VIEWS.map((v, i) => (
        <button
          key={v.mode}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === v.mode}
          aria-label={v.label}
          tabIndex={value === v.mode ? 0 : -1}
          className={`view-switch-option${value === v.mode ? " active" : ""}`}
          onClick={() => onChange(v.mode)}
        >
          {v.mode === "code" ? <Code2 size={15} aria-hidden /> : <span className="view-switch-text">IDE</span>}
        </button>
      ))}
    </div>
  );
}
