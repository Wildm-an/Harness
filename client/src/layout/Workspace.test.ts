import { describe, expect, it } from "vitest";
import { MessageSquare } from "lucide-react";
import type { Group, PaneId, Split } from "./model";
import { minimizeTarget, type PaneSpec } from "./Workspace";

const spec = (onMinimize?: () => void): PaneSpec => ({ title: "", icon: MessageSquare, closable: true, render: () => null, onMinimize });
const group = (active: PaneId): Group => ({ type: "group", id: `g-${active}`, tabs: [active], active });

describe("a double-click on a divider", () => {
  const minimize = () => {};
  const panes = { chat: spec(), browser: spec(minimize), terminal: spec() } as unknown as Record<PaneId, PaneSpec>;

  it("minimizes the browser next to it, on either side", () => {
    expect(minimizeTarget([group("browser"), group("chat")], panes)).toBe(minimize);
    expect(minimizeTarget([group("chat"), group("browser")], panes)).toBe(minimize);
  });

  it("does nothing between panes that cannot minimize", () => {
    expect(minimizeTarget([group("terminal"), group("chat")], panes)).toBeNull();
    const split: Split = { type: "split", id: "s", direction: "column", children: [group("browser")], sizes: [1] };
    expect(minimizeTarget([split, undefined], panes)).toBeNull();
  });
});
