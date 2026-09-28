/** The text of the context length values: token counts and where a length came from. */

/** 1234 -> "1.2k", 32768 -> "33k". */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
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
  summary: "Summary of earlier turns",
  tools: "Built-in tools",
  mcp_tools: "MCP tools",
  messages: "Messages",
};

/**
 * The rows of the context view, as in the /context view of Claude Code: the parts that are not
 * empty, then the free space, then the buffer. The buffer is the space after the compaction point.
 */
export function contextRows(usage: ContextUsage): ContextRow[] {
  const length = Math.max(usage.length, 1);
  const rows: ContextRow[] = usage.parts
    .filter((p) => p.tokens > 0 || p.kind === "messages")
    .map((p) => ({ kind: p.kind, label: PART_LABELS[p.kind] ?? p.kind, tokens: p.tokens, share: p.tokens / length }));
  const compactAt = Math.round(length * usage.compact_at);
  const free = Math.max(0, compactAt - usage.tokens);
  const buffer = Math.max(0, length - Math.max(compactAt, usage.tokens));
  rows.push({ kind: "free", label: "Free space", tokens: free, share: free / length });
  rows.push({ kind: "buffer", label: "Compaction buffer", tokens: buffer, share: buffer / length });
  return rows;
}
