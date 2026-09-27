import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/tauri";
import { parsePathRef, useOpenPath } from "../lib/openPath";

/** Inline code. A file path such as `src/app.py:42` opens the file in the editor. */
function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const openPath = useOpenPath();
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const ref = !className && text && !text.includes("\n") ? parsePathRef(text) : null;
  if (ref && openPath) {
    return (
      <button
        type="button"
        className="path-link"
        onClick={() => openPath(ref.path, ref.line)}
        title={`Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ""} in the editor`}
      >
        {text}
      </button>
    );
  }
  return <code className={className}>{children}</code>;
}

const components: Components = {
  // Open links in the system browser. Do not let a link replace the app page.
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => <Code className={className}>{children}</Code>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
