// The note at the bottom of the window while Harness waits for the agent to finish, before a quit
// or an update. It moves to the left of the Browser pane webview (useClearOfNative), so it always
// shows. The X at the right closes the note and stops the wait, as "Cancel" does.

import { useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { useClearOfNative } from "../lib/overlay";
import { CloseButton } from "./VersionWarning";

export function WaitNote({ text, action, onAction, onCancel }: {
  text: string;
  action: string; // The button that does the work now: "Quit now" or "Update now".
  onAction: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useClearOfNative(ref);
  return (
    <div ref={ref} className="quit-wait" role="status" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <LoaderCircle size={14} className="spin" aria-hidden />
      <span>{text}</span>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="btn btn-small" onClick={onAction}>
        {action}
      </button>
      <CloseButton onClose={onCancel} />
    </div>
  );
}
