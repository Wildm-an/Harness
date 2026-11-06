// The rows of the Changes pane (ChangesView.tsx): the lines of each file of the branch diff, with the
// changed words of a changed line, and a row for the unmodified lines between two parts of a file.

import { parseUnifiedDiff, wordSegments, type Hunk, type LineKind, type Segment } from "./diff";

export type ChangeRow =
  | { kind: "gap"; count: number } // Unmodified lines that the diff does not show.
  | { kind: LineKind; text: string; oldNo?: number; newNo?: number; words?: Segment[] };

/** The number of old lines in a hunk. */
const oldLength = (hunk: Hunk) => hunk.lines.filter((l) => l.kind !== "add").length;

/**
 * The rows of a file: the lines of each part, a gap row between two parts, and a gap row at the start
 * when the first part does not start at line 1. A run of removed lines and the run of added lines after
 * it pair up line by line: each pair gets its changed words.
 */
export function changeRows(hunks: Hunk[]): ChangeRow[] {
  const rows: ChangeRow[] = [];
  let nextOld = 1; // The first old line after the last part.
  for (const hunk of hunks) {
    const skipped = hunk.oldStart - nextOld;
    if (skipped > 0 && !(hunk.oldStart === 0 && hunk.lines.every((l) => l.kind === "add"))) rows.push({ kind: "gap", count: skipped });
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; ) {
      if (lines[i].kind !== "del") {
        rows.push({ ...lines[i] });
        i++;
        continue;
      }
      const dels: number[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(i++);
      const adds: number[] = [];
      while (i < lines.length && lines[i].kind === "add") adds.push(i++);
      const pairs = dels.map((d, k) => (k < adds.length ? wordSegments(lines[d].text, lines[adds[k]].text) : null));
      dels.forEach((d, k) => rows.push({ ...lines[d], words: pairs[k]?.left }));
      adds.forEach((a, k) => rows.push({ ...lines[a], words: pairs[k]?.right }));
    }
    nextOld = Math.max(hunk.oldStart, 1) + oldLength(hunk);
  }
  return rows;
}

/** The parsed diff of a file, and its rows. */
export function fileRows(patch: string): { rows: ChangeRow[]; added: number; removed: number } {
  const parsed = parseUnifiedDiff(patch);
  return { rows: changeRows(parsed.hunks), added: parsed.added, removed: parsed.removed };
}

/** "RailChanges.tsx" and "client/src/components" of a path. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** A run of text with the syntax color class of Monaco ("mtk5"), and the changed-word mark. */
export interface Run {
  text: string;
  cls: string;
  changed?: boolean;
}

/**
 * Put the changed words into the syntax runs of a line: a run splits where a changed word starts or
 * ends. null: the runs do not have the same text as the words (the line shows the words only).
 */
export function mergeRuns(runs: Run[], words: Segment[] | undefined): Run[] | null {
  if (!words) return runs;
  if (runs.map((r) => r.text).join("") !== words.map((w) => w.text).join("")) return null;
  const out: Run[] = [];
  let r = 0;
  let rOff = 0;
  for (const word of words) {
    let left = word.text.length;
    while (left > 0 && r < runs.length) {
      const run = runs[r];
      const take = Math.min(left, run.text.length - rOff);
      out.push({ text: run.text.slice(rOff, rOff + take), cls: run.cls, changed: word.changed });
      left -= take;
      rOff += take;
      if (rOff >= run.text.length) {
        r++;
        rOff = 0;
      }
    }
  }
  return out;
}

/** The runs of each line of the HTML of `monaco.editor.colorize`: one <div> or <br/>-separated line of <span class="mtkN">. */
export function htmlRuns(html: string): Run[][] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const lines: Run[][] = [[]];
  const walk = (node: Node, cls: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeName === "BR") lines.push([]);
      else if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/ /g, " ");
        if (text) lines[lines.length - 1].push({ text, cls });
      } else if (child instanceof Element) {
        const own = Array.from(child.classList).find((c) => /^mtk\d+$/.test(c)) ?? cls;
        walk(child, own);
      }
    }
  };
  walk(doc.body.firstChild ?? doc.body, "");
  return lines;
}
