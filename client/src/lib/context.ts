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
