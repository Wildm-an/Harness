/** The text of the context length values: token counts and where a length came from. */

/** One decimal place, with no ".0": 130.8, 200, 1. */
function oneDecimal(x: number): string {
  const text = (Math.round(x * 10) / 10).toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** As in Claude: 512 -> "512", 1234 -> "1.2k", 130800 -> "130.8k", 1000000 -> "1M", 1500000 -> "1.5M". */
export function formatTokens(n: number): string {
  // 999,950 and more round to "1000k", so they show as millions.
  if (n >= 999_950) return `${oneDecimal(n / 1_000_000)}M`;
  if (n >= 1000) return `${oneDecimal(n / 1000)}k`;
  return String(n);
}

/** Where the context length came from, in words for the context meter. */
export function contextSourceText(source: string | undefined): string {
  if (!source) return "";
  if (source === "default") {
    return "The endpoint did not give the context length, so the harness uses a default. Set context_length in providers.json.";
  }
  if (source === "settings") return "The context length comes from the project settings.";
  if (source === "providers.json") return "The context length comes from providers.json.";
  return `The context length comes from the endpoint (${source}).`;
}

/** The reply to context.get: the parts of the next request, in tokens. */
export interface ContextUsage {
  tokens: number;
  length: number;
  compact_at: number; // The agent summarizes old turns at this share of the length.
  source?: string;
  parts: { kind: string; tokens: number }[];
}

export interface ContextRow {
  kind: string; // A part kind, or "free" or "buffer".
  label: string;
  tokens: number;
  share: number; // Of the context length, 0 to 1.
}

const PART_LABELS: Record<string, string> = {
  system: "System prompt",
  instructions: "Project instructions",
  skills: "Skills",
  plugins: "Plugins",
  summary: "Summary of earlier turns",
  tools: "System tools",
  mcp_tools: "MCP tools",
  messages: "Messages",
};

/**
 * The order of two parts with the same size, as in the /context view of Claude Code: System prompt,
 * System tools, MCP tools, Memory files, Skills, Messages. Plugins go with the skills. The summary
 * goes with the messages. A part kind that is not in this list goes after them.
 */
const PART_ORDER = ["system", "tools", "mcp_tools", "instructions", "skills", "plugins", "summary", "messages"];

function partRank(kind: string): number {
  const i = PART_ORDER.indexOf(kind);
  return i < 0 ? PART_ORDER.length : i;
}

/**
 * The rows of the context view: the parts that are not empty, the largest first (the user asked
 * for this), then the free space, then the buffer. The buffer is the space after the compaction point.
 */
export function contextRows(usage: ContextUsage): ContextRow[] {
  const length = Math.max(usage.length, 1);
  const rows: ContextRow[] = usage.parts
    .filter((p) => p.tokens > 0 || p.kind === "messages")
    // A stable sort: two parts of one kind and size keep their order.
    .sort((a, b) => b.tokens - a.tokens || partRank(a.kind) - partRank(b.kind))
    .map((p) => ({ kind: p.kind, label: PART_LABELS[p.kind] ?? p.kind, tokens: p.tokens, share: p.tokens / length }));
  const compactAt = Math.round(length * usage.compact_at);
  const free = Math.max(0, compactAt - usage.tokens);
  const buffer = Math.max(0, length - Math.max(compactAt, usage.tokens));
  rows.push({ kind: "free", label: "Free space", tokens: free, share: free / length });
  rows.push({ kind: "buffer", label: "Compaction buffer", tokens: buffer, share: buffer / length });
  return rows;
}
