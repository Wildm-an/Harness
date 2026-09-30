// The pane layout (SPEC.md section 8.4): windows in nested rows and columns.
// Each window (a "group") shows one pane, as in the Claude Code desktop app. The data keeps a list
// of tabs: only the narrow window view puts all panes in one group. A saved layout from an older
// version can have groups with more tabs: normalize() gives each pane its own window.
// All functions are pure. Each one returns a new layout.

export type PaneId = "chat" | "editor" | "browser" | "servers" | "diff" | "rules" | "skills" | "mcp" | "terminal" | "side" | "tasks";
export const PANE_IDS: PaneId[] = ["chat", "editor", "browser", "servers", "diff", "rules", "skills", "mcp", "terminal", "side", "tasks"];

export type Zone = "center" | "left" | "right" | "top" | "bottom";

export interface Group {
  type: "group";
  id: string;
  tabs: PaneId[];
  active: PaneId;
}

export interface Split {
  type: "split";
  id: string;
  direction: "row" | "column";
  children: LayoutNode[];
  sizes: number[]; // Shares of the space. The sum is 1.
}

export type LayoutNode = Group | Split;

let counter = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

// The share of the workspace width for the windows beside the chat. The workspace sets it from the
// last width of the side windows (Workspace.tsx), so a new side area opens at the width of the last one.
let sideShare = 0.55;
const MIN_SIDE_SHARE = 0.2;
const MAX_SIDE_SHARE = 0.8;

export function setSideShare(share: number): void {
  if (Number.isFinite(share)) sideShare = Math.min(MAX_SIDE_SHARE, Math.max(MIN_SIDE_SHARE, share));
}

export function getSideShare(): number {
  return sideShare;
}

const chatSizes = (): number[] => [1 - sideShare, sideShare];

/** The share of the side windows in a layout: the part of the root row that is not the chat. */
export function sideShareOf(node: LayoutNode): number | null {
  if (node.type !== "split" || node.direction !== "row" || node.children.length < 2) return null;
  const i = node.children.findIndex((c) => c.type === "group" && c.tabs.includes("chat"));
  return i < 0 ? null : 1 - (node.sizes[i] ?? 0);
}

export function group(tabs: PaneId[], active?: PaneId): Group {
  return { type: "group", id: newId("g"), tabs, active: active ?? tabs[0] };
}

function split(direction: Split["direction"], children: LayoutNode[], sizes?: number[]): Split {
  return { type: "split", id: newId("s"), direction, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

/** Chat on the left. The editor on the right (SPEC.md section 8.4). */
export function defaultLayout(): LayoutNode {
  return split("row", [group(["chat"]), group(["editor"])], chatSizes());
}

/** One window for each pane of a group: the chat on the left, the other panes in a column. */
function splitTabs(g: Group): LayoutNode {
  if (g.tabs.length < 2) return g;
  const others = g.tabs.filter((t) => t !== "chat");
  const column =
    others.length === 1 ? group(others) : split("column", others.map((t) => group([t])));
  if (!g.tabs.includes("chat")) return column.type === "group" ? { ...column, id: g.id } : column;
  return split("row", [{ ...group(["chat"]), id: g.id }, column], chatSizes());
}

export function groups(node: LayoutNode): Group[] {
  return node.type === "group" ? [node] : node.children.flatMap(groups);
}

export function findGroupOf(node: LayoutNode, pane: PaneId): Group | null {
  return groups(node).find((g) => g.tabs.includes(pane)) ?? null;
}

function mapGroups(node: LayoutNode, fn: (g: Group) => LayoutNode | null): LayoutNode | null {
  if (node.type === "group") return fn(node);
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = mapGroups(child, fn);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (children.length === 0) return null;
  return { ...node, children, sizes };
}

/**
 * The chat always has the full height: no pane is above or below it. The group of the chat is
 * never in a column split.
 */
export function chatHasFullHeight(node: LayoutNode, inColumn = false): boolean {
  if (node.type === "group") return !(inColumn && node.tabs.includes("chat"));
  return node.children.every((c) => chatHasFullHeight(c, inColumn || node.direction === "column"));
}

/** Moves the group of the chat out of a column split: the chat on the left, the other panes on the right. */
function giveChatFullHeight(node: LayoutNode): LayoutNode {
  const chat = findGroupOf(node, "chat");
  if (!chat || chatHasFullHeight(node)) return node;
  const rest = mapGroups(node, (g) => (g.id === chat.id ? null : g));
  return rest ? split("row", [chat, rest], chatSizes()) : chat;
}

/**
 * Removes empty groups and splits with one child. The sizes of each split add up to 1. The chat
 * gets the full height (a saved layout can have a pane below the chat).
 */
export function normalize(node: LayoutNode | null): LayoutNode {
  const clean = cleanLayout(node);
  return chatHasFullHeight(clean) ? clean : cleanLayout(giveChatFullHeight(clean));
}

function cleanLayout(node: LayoutNode | null): LayoutNode {
  if (!node) return defaultLayout();
  const clean = (n: LayoutNode): LayoutNode | null => {
    if (n.type === "group") {
      const tabs = n.tabs.filter((t, i) => PANE_IDS.includes(t) && n.tabs.indexOf(t) === i);
      if (tabs.length === 0) return null;
      return splitTabs({ ...n, tabs, active: tabs.includes(n.active) ? n.active : tabs[0] });
    }
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const cleaned = clean(c);
      if (!cleaned) return;
      // A child split with the same direction joins this split.
      if (cleaned.type === "split" && cleaned.direction === n.direction) {
        const share = n.sizes[i] ?? 0;
        cleaned.children.forEach((cc, j) => {
          kids.push(cc);
          sizes.push(share * (cleaned.sizes[j] ?? 0));
        });
      } else {
        kids.push(cleaned);
        sizes.push(n.sizes[i] ?? 0);
      }
    });
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    const total = sizes.reduce((a, b) => a + b, 0);
    return { ...n, children: kids, sizes: sizes.map((s) => (total > 0 ? s / total : 1 / kids.length)) };
  };
  return clean(node) ?? defaultLayout();
}

export function activate(node: LayoutNode, pane: PaneId): LayoutNode {
  return normalize(mapGroups(node, (g) => (g.tabs.includes(pane) ? { ...g, active: pane } : g)));
}

export function closePane(node: LayoutNode, pane: PaneId): LayoutNode {
  return normalize(
    mapGroups(node, (g) => {
      if (!g.tabs.includes(pane)) return g;
      const index = g.tabs.indexOf(pane);
      const tabs = g.tabs.filter((t) => t !== pane);
      if (tabs.length === 0) return null;
      return { ...g, tabs, active: g.active === pane ? tabs[Math.max(0, index - 1)] : g.active };
    }),
  );
}

/**
 * Shows a pane in its own window. A new window goes below ``targetGroupId``, or below the last
 * window that has no chat, or on the right of the chat.
 */
export function openPane(node: LayoutNode, pane: PaneId, targetGroupId?: string): LayoutNode {
  if (findGroupOf(node, pane)) return activate(node, pane);
  const all = groups(node);
  const others = all.filter((g) => !g.tabs.includes("chat"));
  const target = all.find((g) => g.id === targetGroupId && !g.tabs.includes("chat")) ?? others[others.length - 1];
  if (!target) return normalize(split("row", [node, group([pane])], chatSizes()));
  return normalize(mapGroups(node, (g) => (g.id === target.id ? split("column", [g, group([pane])]) : g)));
}

/** Shows a pane, or closes it if it is the active tab of its group. */
export function togglePane(node: LayoutNode, pane: PaneId, show: (n: LayoutNode) => LayoutNode = (n) => openPane(n, pane)): LayoutNode {
  return findGroupOf(node, pane)?.active === pane ? closePane(node, pane) : show(node);
}

/**
 * Moves the window of a pane to one side of another window. Each pane has its own window, so a
 * move to the "center" of a window does nothing. A move that puts a pane above or below the chat
 * does nothing.
 */
export function movePane(node: LayoutNode, pane: PaneId, targetGroupId: string, zone: Zone): LayoutNode {
  const source = findGroupOf(node, pane);
  const target = groups(node).find((g) => g.id === targetGroupId);
  if (!source || !target) return node;
  if (zone === "center") return source.id === target.id ? activate(node, pane) : node;
  // One pane alone cannot move beside itself.
  if (source.id === target.id && source.tabs.length === 1) return node;

  const without = mapGroups(node, (g) => {
    if (g.id !== source.id) return g;
    const tabs = g.tabs.filter((t) => t !== pane);
    return tabs.length ? { ...g, tabs, active: g.active === pane ? tabs[0] : g.active } : null;
  });
  if (!without) return normalize(null);

  const placed = mapGroups(without, (g) => {
    if (g.id !== target.id) return g;
    const fresh = group([pane]);
    const direction = zone === "left" || zone === "right" ? "row" : "column";
    const children = zone === "left" || zone === "top" ? [fresh, g] : [g, fresh];
    return split(direction, children, [0.5, 0.5]);
  });
  if (placed && !chatHasFullHeight(placed)) return node;
  return normalize(placed);
}

/** True if the move changes the layout and keeps the chat at the full height. */
export function canMove(node: LayoutNode, pane: PaneId, targetGroupId: string, zone: Zone): boolean {
  return movePane(node, pane, targetGroupId, zone) !== node;
}

export function resize(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.type === "group") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => resize(c, splitId, sizes)) };
}

/** Reads a saved layout. Returns null for data that is not a valid layout. */
export function parseLayout(value: unknown): LayoutNode | null {
  const check = (v: unknown): v is LayoutNode => {
    if (!v || typeof v !== "object") return false;
    const n = v as Record<string, unknown>;
    if (n.type === "group") return Array.isArray(n.tabs) && typeof n.id === "string";
    if (n.type === "split") {
      return (
        (n.direction === "row" || n.direction === "column") &&
        Array.isArray(n.children) &&
        Array.isArray(n.sizes) &&
        n.children.every(check)
      );
    }
    return false;
  };
  if (!check(value)) return null;
  const node = normalize(value);
  // The chat must be in the layout: without it, the user cannot type a prompt.
  return findGroupOf(node, "chat") ? node : openPane(node, "chat");
}
