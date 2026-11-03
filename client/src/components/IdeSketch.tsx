// A small drawing of an IDE layout (Settings > Appearance > IDE view, and the Layout menu of the
// IDE view): E is the editor, T the terminal, C the chat, and D the Changes pane.

import type { IdePreset } from "../layout/model";

const AREAS: Record<IdePreset, string[]> = {
  classic: ["e c", "t c"],
  focus: ["e c", "e c"],
  wideTerminal: ["e c", "t t"],
  review: ["e d c", "t t c"],
};

const NAMES: Record<string, string> = { e: "Editor", t: "Terminal", c: "Chat", d: "Changes" };

export function IdeSketch({ preset, chatSide, small }: { preset: IdePreset; chatSide: "left" | "right"; small?: boolean }) {
  const rows = AREAS[preset].map((row) => {
    const cells = row.split(" ");
    return (chatSide === "left" ? [...cells].reverse() : cells).join(" ");
  });
  const cols = preset === "review" ? (chatSide === "left" ? "1fr 2fr 1.4fr" : "2fr 1.4fr 1fr") : chatSide === "left" ? "1fr 2.3fr" : "2.3fr 1fr";
  const used = new Set(rows.join(" ").split(" "));
  return (
    <span
      className={`ide-sketch${small ? " small" : ""}`}
      aria-hidden
      style={{ gridTemplateAreas: rows.map((r) => `"${r}"`).join(" "), gridTemplateColumns: cols }}
    >
      {[...used].map((a) => (
        <span key={a} className={`ide-sketch-${a}`} style={{ gridArea: a }} title={small ? undefined : NAMES[a]} />
      ))}
    </span>
  );
}
