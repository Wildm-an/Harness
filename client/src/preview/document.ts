// Pure helpers of the Preview pane. They import no renderer, so the unit tests can load them.

import { normalizePath } from "../editor/paths";

export type PreviewKind = "pdf" | "docx";

/** The renderer of a file, by its extension, or null when the Preview pane cannot show it. */
export function previewKind(path: string): PreviewKind | null {
  const m = /\.(pdf|docx)$/i.exec(path.trim());
  return m ? (m[1].toLowerCase() as PreviewKind) : null;
}

export function isPreviewFile(path: string): boolean {
  return previewKind(path) !== null;
}

/** The document of the Preview pane. The daemon sends the bytes with "fs.bytes". */
export type PreviewDoc =
  | { path: string; status: "loading" }
  | { path: string; status: "ready"; data: Uint8Array }
  | { path: string; status: "error"; error: string };

/** The bytes of a base64 text. */
export function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// The zoom steps of the PDF view, as in a browser PDF viewer.
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** The next zoom step up (dir 1) or down (dir -1) from a zoom. It stays in the steps. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0];
}

/** The zoom at which a page of `pageWidth` CSS pixels (at zoom 1) fills `paneWidth`, less the margins. */
export function fitWidthZoom(paneWidth: number, pageWidth: number, margin = 32): number {
  if (!(pageWidth > 0) || !(paneWidth > margin)) return 1;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], (paneWidth - margin) / pageWidth));
}

/**
 * The project path that a "show_document" tool call opens, or null for any other call. The client
 * opens the Preview pane only after a result with no error: then the daemon checked the file.
 */
export function shownDocument(name: string, input: unknown, isError: boolean, cwd: string): string | null {
  if (name !== "show_document" || isError || !input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).path;
  if (typeof raw !== "string" || !isPreviewFile(raw)) return null;
  return normalizePath(raw, cwd);
}

/** What a click on a link of a Word document does: open a web link, go to a bookmark, or nothing. */
export function linkAction(href: string | null): { kind: "external"; url: string } | { kind: "anchor"; id: string } | null {
  const h = (href ?? "").trim();
  if (h.startsWith("#") && h.length > 1) return { kind: "anchor", id: decodeURIComponent(h.slice(1)) };
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "external", url: h };
  return null;
}
