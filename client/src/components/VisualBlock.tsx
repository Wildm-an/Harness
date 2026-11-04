// A visual of the agent in the chat (show_visual, lib/visual.ts), as in the Claude app: a header
// "Made a visual" with a caret that folds it, and the visual in a sandboxed iframe. A sendPrompt
// call in the visual sends its text as the next prompt.

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { currentTheme, onThemeChange } from "../lib/theme";
import {
  frameHeight,
  frameMessage,
  MIN_HEIGHT,
  MSG_DOC,
  MSG_THEME,
  type Visual,
  type VisualTheme,
  themeVars,
  visualDocument,
  visualFrameUrl,
} from "../lib/visual";

// A visual cannot send prompts faster than this.
const PROMPT_GAP_MS = 1000;

function readTheme(): VisualTheme {
  return { theme: currentTheme(), vars: themeVars(getComputedStyle(document.documentElement)) };
}

export const VisualBlock = memo(function VisualBlock({ visual, onPrompt }: { visual: Visual; onPrompt?: (text: string) => void }) {
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(MIN_HEIGHT);
  // The frame shows after its first size message. Before it, the empty frame page can paint an opaque canvas.
  const [sized, setSized] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const bodyId = useId();
  const lastPrompt = useRef(0);
  const promptRef = useRef(onPrompt);
  promptRef.current = onPrompt;

  // The document gets the theme when it loads. Later theme changes go to it as messages.
  const src = useMemo(() => visualFrameUrl(), []);
  const doc = useMemo(() => (src ? "" : visualDocument(visual.code, readTheme())), [src, visual.code]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const msg = frameMessage(e.data);
      if (!msg) return;
      if (msg.kind === "ready") win.postMessage({ type: MSG_DOC, html: visualDocument(visual.code, readTheme()) }, "*");
      else if (msg.kind === "size") {
        setHeight(frameHeight(msg.height));
        setSized(true);
      } else if (msg.kind === "prompt") {
        // Only a click in this visual can send a prompt: the frame has the focus after the click.
        const now = Date.now();
        if (document.activeElement !== frame.current || now - lastPrompt.current < PROMPT_GAP_MS) return;
        lastPrompt.current = now;
        promptRef.current?.(msg.text);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [visual.code]);

  useEffect(
    () =>
      onThemeChange(() => {
        const t = readTheme();
        frame.current?.contentWindow?.postMessage({ type: MSG_THEME, theme: t.theme, vars: t.vars }, "*");
      }),
    [],
  );

  return (
    <section className={`visual-block${open ? " open" : ""}`} aria-label={`Visual: ${visual.title}`}>
      <button type="button" className="tool-group-head visual-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="tool-group-text">Made a visual</span>
        <ChevronRight className="tool-chevron" size={14} aria-hidden />
      </button>
      <div className="visual-body" id={bodyId} hidden={!open}>
        <iframe
          ref={frame}
          className="visual-frame"
          // A name for screen readers. A title would show a hover tip on the whole visual.
          aria-label={visual.title}
          // No allow-same-origin: the visual has its own origin and cannot read the app.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          {...(src ? { src } : { srcDoc: doc })}
          style={{ height, visibility: sized ? "visible" : "hidden" }}
        />
      </div>
    </section>
  );
});
