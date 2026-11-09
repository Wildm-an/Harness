// What the chat cards of send_file, artifact, and preview_navigate (ShareCards.tsx) need from the app:
// the Browser pane and its tabs, the HTTP address of the daemon, and whether the daemon runs on this computer.

import { createContext, useContext } from "react";

export interface CardActions {
  openInBrowser: (url: string) => void; // Shows a URL in the Browser pane.
  openTab: (tab: string | null, url: string) => void; // Shows a tab in the Browser pane. A closed tab: the URL opens in a new tab.
  minimizeTab: ((tab: string) => boolean) | null; // Shows a tab in the session rail. null: no rail (the IDE view). false: the tab is closed.
  closeTab: (tab: string) => void;
  hasTab: (tab: string) => boolean;
  daemonBase: string | null; // "http://127.0.0.1:47615", or null with no connection.
  local: boolean; // The daemon runs on this computer: its file paths open in the apps of this computer.
}

export const CardActionsContext = createContext<CardActions | null>(null);

export function useCardActions(): CardActions | null {
  return useContext(CardActionsContext);
}

/** The URL of an artifact page on the daemon. */
export function artifactUrl(base: string, id: string): string {
  return `${base.replace(/\/$/, "")}/artifacts/${encodeURIComponent(id)}/`;
}

export type FileKind = "pdf" | "docx" | "image" | "html" | "sheet" | "slides" | "text" | "code" | "archive" | "file";

const KINDS: [FileKind, RegExp][] = [
  ["pdf", /\.pdf$/i],
  ["docx", /\.(docx?|odt|rtf)$/i],
  ["image", /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i],
  ["html", /\.html?$/i],
  ["sheet", /\.(xlsx?|csv|tsv|ods)$/i],
  ["slides", /\.(pptx?|odp)$/i],
  ["text", /\.(md|markdown|txt|log|rst)$/i],
  ["code", /\.(json|ya?ml|toml|xml|[jt]sx?|py|rs|go|java|c|cpp|h|cs|rb|php|sh|ps1|sql|css)$/i],
  ["archive", /\.(zip|tar|gz|tgz|7z|rar)$/i],
];

/** The kind of a file, by its extension. */
export function fileKind(name: string): FileKind {
  return KINDS.find(([, re]) => re.test(name))?.[0] ?? "file";
}

export const KIND_LABEL: Record<FileKind, string> = {
  pdf: "PDF document",
  docx: "Word document",
  image: "Image",
  html: "HTML page",
  sheet: "Spreadsheet",
  slides: "Presentation",
  text: "Text",
  code: "Code",
  archive: "Archive",
  file: "File",
};

/** The kinds that a pane of the app shows: the Preview pane, the Browser pane, or the editor. */
export function opensInPane(kind: FileKind): boolean {
  return kind !== "sheet" && kind !== "slides" && kind !== "archive" && kind !== "file";
}

/**
 * Where a card opens a sent file. "pane": a pane of the app. "app": the default app of the computer.
 * "none": a file that the app cannot open (out of the project, on another computer).
 * "render" and "auto" use a pane when the pane can show the file. "attach" uses the default app.
 */
export function openTarget(display: "render" | "attach" | "auto", kind: FileKind, inProject: boolean, local: boolean): "pane" | "app" | "none" {
  const pane = inProject && opensInPane(kind);
  if (display !== "attach" && pane) return "pane";
  if (local) return "app";
  return pane ? "pane" : "none";
}
