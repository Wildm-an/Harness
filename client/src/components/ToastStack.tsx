// The popups at the bottom right of the app: the app update, the daemon version, and the daemon
// update. They stack upward, so they do not cover each other. The Browser pane webview is a native
// window over the app, so the stack moves to the left of the webview (useClearOfNative): the
// popups always show, whatever panes are open.

import { useRef, type ReactNode } from "react";
import { useClearOfNative } from "../lib/overlay";

export function ToastStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useClearOfNative(ref);
  return (
    <div ref={ref} className="toast-stack">
      {children}
    </div>
  );
}
