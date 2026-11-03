// A small drawing of an IDE layout (Settings > Appearance > IDE view, and the Layout menu of the
// IDE view): F is the Files pane, E the editor, T the terminal, C the chat, and D the Changes pane.

import type { IdePreset } from "../layout/model";

// The rows with the chat at the right. With the chat at the left, the chat column moves to the front.
const AREAS: Record<IdePreset, string[]> = {
  classic: ["f e c", "f t c"],
  focus: ["f e c", "f e c"],
  wideTerminal: ["f e c", "t t t"],
  review: ["f e d c", "f t t c"],
};

const WIDTHS: Record<string, string> = { f: "0.8fr", e: "2fr", d: "1.3fr", c: "1fr", t: "1fr" };
const NAMES: Record<string, string> = { f: "Files", e: "Editor", t: "Terminal", c: "Chat", d: "Changes" };

export function IdeSketch({ preset, chatSide, small }: { preset: IdePreset; chatSide: "left" | "right"; small?: boolean }) {
  const rows = AREAS[preset].map((row) => {
    const cells = row.split(" ");
    if (chatSide === "right" || cells[cells.length - 1] !== "c") return cells;
    return ["c", ...cells.slice(0, -1)];
  });
  const cols = (rows.find((r) => !r.every((c) => c === "t")) ?? rows[0]).map((c) => WIDTHS[c]).join(" ");
  const used = new Set(rows.flat());
  return (
    <span
      className={`ide-sketch${small ? " small" : ""}`}
      aria-hidden
      style={{ gridTemplateAreas: rows.map((r) => `"${r.join(" ")}"`).join(" "), gridTemplateColumns: cols }}
    >
      {[...used].map((a) => (
        <span key={a} className={`ide-sketch-${a}`} style={{ gridArea: a }} title={small ? undefined : NAMES[a]} />
      ))}
    </span>
  );
}
