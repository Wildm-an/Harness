// Unified diff parsing for the diff review pane.

import { diffWordsWithSpace } from "diff";

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string; // The text after the second "@@", for example a function name.
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  path: string;
  hunks: Hunk[];
  added: number;
  removed: number;
  isNewFile: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { path: "", hunks: [], added: 0, removed: 0, isNewFile: false };
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const rawLines = text.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop(); // The newline at the end of the diff.

  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("--- ")) {
      if (line.slice(4) === "/dev/null") result.isNewFile = true;
      else result.path ||= stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line.slice(4) !== "/dev/null") result.path = stripPrefix(line.slice(4));
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: m[3].trim(), oldStart: oldNo, newStart: newNo, lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue; // "\ No newline at end of file"
    const body = line.slice(1);
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: body, newNo: newNo++ });
      result.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: body, oldNo: oldNo++ });
      result.removed++;
    } else if (line.startsWith(" ") || line === "") {
      // An empty line in the body is a context line with no text (some tools drop the space).
      hunk.lines.push({ kind: "context", text: body, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return result;
}

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** Pairs deleted lines with the added lines that follow them, for the side-by-side view. */
export function toSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k], right: adds[k] });
    }
  }
  return rows;
}

export interface Segment {
  text: string;
  changed: boolean;
}

// Below this share of unchanged characters, word highlights are noise. Show the whole line as changed.
const MIN_SIMILARITY = 0.35;

/** Word-level segments for a changed line pair. Returns null if the lines are too different. */
export function wordSegments(oldText: string, newText: string): { left: Segment[]; right: Segment[] } | null {
  const parts = diffWordsWithSpace(oldText, newText);
  const left: Segment[] = [];
  const right: Segment[] = [];
  let same = 0;
  for (const part of parts) {
    if (part.added) right.push({ text: part.value, changed: true });
    else if (part.removed) left.push({ text: part.value, changed: true });
    else {
      same += part.value.length;
      left.push({ text: part.value, changed: false });
      right.push({ text: part.value, changed: false });
    }
  }
  const longest = Math.max(oldText.length, newText.length, 1);
  return same / longest >= MIN_SIMILARITY ? { left, right } : null;
}
