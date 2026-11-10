import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizeMath } from "../lib/math";
import { openLink } from "../lib/openLink";
import { parsePathRef, useOpenPath } from "../lib/openPath";
import { prInfoStore, prUrlRef, usePrInfo } from "../lib/pr";
import { PrCard, PrIcon, useHoverCard } from "./PrCard";

/** The URL of an inline code span that holds only one http or https URL, else null. */
export function codeSpanUrl(text: string): string | null {
  const m = /^<?(https?:\/\/[^\s<>`]+?)>?$/i.exec(text.trim());
  return m ? m[1] : null;
}

/** A chat link. It opens in the Browser pane or the system browser. It does not replace the app page. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && prUrlRef(href)) return <PrLink href={href}>{children}</PrLink>;
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
 * A link to a GitHub pull request, as in the Claude app: the PR icon in the color of its state, and a
 * hover card with the state, the title, the author, and the line counts (git.pr_info).
 */
function PrLink({ href, children }: { href: string; children?: ReactNode }) {
  const pr = usePrInfo(href);
  useEffect(() => prInfoStore.request(href), [href]);
  const hover = useHoverCard(() => <PrCard pr={pr} url={href} loading={pr === undefined} />);
  return (
    <>
      <a
        href={href}
        className="pr-link"
        data-hover-card
        {...hover.anchor}
        onClick={(e) => {
          e.preventDefault();
          openLink(href);
        }}
      >
        <PrIcon state={pr?.state ?? null} size={14} />
        {children}
      </a>
      {hover.card}
    </>
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

/** A code block with a copy button at its top right (audit U10). The button shows on hover and on keyboard focus. */
function Pre({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = (ref.current?.textContent ?? "").replace(/\n$/, "");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-pre">
      <pre ref={ref}>{children}</pre>
      <button type="button" className="icon-btn ghost md-copy" aria-label="Copy code" title={copied ? "Copied" : "Copy code"} onClick={copy}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}

const components: Components = {
  // Open links in the system browser, or in the Browser pane. Do not let a link replace the app page.
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  code: ({ className, children }) => <Code className={className}>{children}</Code>,
  pre: ({ children }) => <Pre>{children}</Pre>,
  // A table that is wider than the chat scrolls in its own box. The chat does not scroll sideways.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];
// Equations show with KaTeX. An equation with an error shows its LaTeX source in muted text.
const rehypePlugins: Options["rehypePlugins"] = [[rehypeKatex, { errorColor: "var(--text-muted)" }]];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Splits streamed Markdown into blocks at blank lines outside code fences, where the next line starts at
 * column 0 (an indented line can continue a list item). Only the last block can still change.
 */
export function streamBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null && lines[i].trim() === "" && i + 1 < lines.length && /^\S/.test(lines[i + 1])) {
      blocks.push(lines.slice(start, i).join("\n"));
      start = i + 1;
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks.filter((b, i) => b.trim() !== "" || i === blocks.length - 1);
}

/**
 * The reply that streams now. Each finished block is parsed one time. Only the last block is parsed again
 * for each new text, not the whole reply. The full reply is parsed one time when the stream ends.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const blocks = streamBlocks(normalizeMath(text));
  return (
    <div className="markdown markdown-stream">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} text={block} />
      ))}
    </div>
  );
}

/** One block of the stream. `normalizeMath` ran on the full text before the split. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
