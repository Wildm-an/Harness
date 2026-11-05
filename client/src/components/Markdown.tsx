import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openLink } from "../lib/openLink";
import { parsePathRef, useOpenPath } from "../lib/openPath";

/** The URL of an inline code span that holds only one http or https URL, else null. */
export function codeSpanUrl(text: string): string | null {
  const m = /^<?(https?:\/\/[^\s<>`]+?)>?$/i.exec(text.trim());
  return m ? m[1] : null;
}

/** A chat link. It opens in the Browser pane or the system browser. It does not replace the app page. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) openLink(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Inline code. A file path such as `src/app.py:42` opens the file in the Files pane.
 * A URL such as `https://example.com` is a link: the model sometimes writes a URL in backticks.
 */
function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const openPath = useOpenPath();
  const text = typeof children === "string" ? children : Array.isArray(children) && children.every((c) => typeof c === "string") ? children.join("") : null;
  const inline = !className && text !== null && !text.includes("\n") ? text : null;
  const url = inline ? codeSpanUrl(inline) : null;
  if (url) return <Link href={url}>{url}</Link>;
  const ref = inline ? parsePathRef(inline) : null;
  if (ref && openPath) {
    return (
      <button
        type="button"
        className="path-link"
        onClick={() => openPath(ref.path, ref.line)}
        title={`Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ""} in the Files pane`}
      >
        {text}
      </button>
    );
  }
  return <code className={className}>{children}</code>;
}

const components: Components = {
  // Open links in the system browser, or in the Browser pane. Do not let a link replace the app page.
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
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
