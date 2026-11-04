// The pane layout (SPEC.md section 8.4): windows in nested rows and columns.
// Each window (a "group") shows one pane, as in the Claude Code desktop app. The data keeps a list
// of tabs: only the narrow window view puts all panes in one group. A saved layout from an older
// version can have groups with more tabs: normalize() gives each pane its own window.
// All functions are pure. Each one returns a new layout.

// "preview": a PDF or Word file (preview/PreviewPane.tsx).
// "files": the file list and search of the editor as its own window (the IDE view, as VS Code's Explorer).
// The Skills and MCP panes of older versions are gone: the Capabilities page shows both. normalize() drops them.
// A saved layout with a pane that is no longer here (for example "servers") loses that pane when it loads.
export type PaneId = "chat" | "editor" | "files" | "browser" | "diff" | "rules" | "terminal" | "side" | "tasks" | "preview";
export const PANE_IDS: PaneId[] = ["chat", "editor", "files", "browser", "diff", "rules", "terminal", "side", "tasks", "preview"];

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

/**
 * The IDE view, as in Cursor: the editor (with its file tree) and the terminal under it on the
 * left, and the chat with the agent at the right.
 */
export function ideLayout(): LayoutNode {
  return ideLayoutFor(DEFAULT_IDE_OPTIONS);
}

/** The arrangements of the IDE view (Settings > Appearance > IDE view), from Cursor, OpenCode, and Hermes. */
export type IdePreset = "classic" | "focus" | "wideTerminal" | "review";

export interface IdeLayoutOptions {
  preset: IdePreset;
  chatSide: "left" | "right";
  chatShare: number; // The share of the window width for the chat: 0.2 to 0.5.
  terminalShare: number; // The share of the height for the terminal: 0.15 to 0.5.
}

export const DEFAULT_IDE_OPTIONS: IdeLayoutOptions = { preset: "classic", chatSide: "right", chatShare: 0.3, terminalShare: 0.28 };

const clampShare = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

/**
 * The IDE layout of the options:
 * - classic: the editor with the terminal under it, and the chat at the side.
 * - focus: the editor and the chat. No terminal.
 * - wideTerminal: the editor and the chat, and the terminal under both, at the full width.
 * - review: the editor and the Changes pane with the terminal under them, and the chat at the side.
 */
export function ideLayoutFor(options: IdeLayoutOptions): LayoutNode {
  // As VS Code: the Files pane (the Explorer) at the left in the full height, the work in the
  // middle, and the chat at the side. With the chat at the left: the chat, the Files, the work.
  const chat = clampShare(options.chatShare, 0.2, 0.5, DEFAULT_IDE_OPTIONS.chatShare);
  const term = clampShare(options.terminalShare, 0.15, 0.5, DEFAULT_IDE_OPTIONS.terminalShare);
  const files = FILES_SHARE;
  const withSides = (work: LayoutNode): LayoutNode =>
    options.chatSide === "left"
      ? split("row", [group(["chat"]), group(["files"]), work], [chat, files, 1 - chat - files])
      : split("row", [group(["files"]), work, group(["chat"])], [files, 1 - files - chat, chat]);
  const underTerminal = (work: LayoutNode): LayoutNode => split("column", [work, group(["terminal"])], [1 - term, term]);
  switch (options.preset) {
    case "focus":
      return withSides(group(["editor"]));
    case "wideTerminal":
      return underTerminal(withSides(group(["editor"])));
    case "review":
      return withSides(underTerminal(split("row", [group(["editor"]), group(["diff"])], [0.6, 0.4])));
    default:
      return withSides(underTerminal(group(["editor"])));
  }
}

/** The share of the window width for the Files pane of the IDE view. */
export const FILES_SHARE = 0.17;

/**
 * The IDE layout of version 0.1.34 and before: the file list inside the editor pane. A saved
 * layout that is still this default (the user did not change it) gets the new default.
 */
export function legacyIdeLayoutFor(options: IdeLayoutOptions): LayoutNode {
  const chat = clampShare(options.chatShare, 0.2, 0.5, DEFAULT_IDE_OPTIONS.chatShare);
  const term = clampShare(options.terminalShare, 0.15, 0.5, DEFAULT_IDE_OPTIONS.terminalShare);
  const withChat = (work: LayoutNode): LayoutNode =>
    options.chatSide === "left"
      ? split("row", [group(["chat"]), work], [chat, 1 - chat])
      : split("row", [work, group(["chat"])], [1 - chat, chat]);
  const underTerminal = (work: LayoutNode): LayoutNode => split("column", [work, group(["terminal"])], [1 - term, term]);
  switch (options.preset) {
    case "focus":
      return withChat(group(["editor"]));
    case "wideTerminal":
      return underTerminal(withChat(group(["editor"])));
    case "review":
      return withChat(underTerminal(split("row", [group(["editor"]), group(["diff"])], [0.6, 0.4])));
    default:
      return withChat(underTerminal(group(["editor"])));
  }
}

/** The shape of a layout with no window ids, to compare two layouts: the panes, the splits, and the sizes (two decimals). */
export function layoutSignature(node: LayoutNode): string {
  if (node.type === "group") return `[${node.tabs.join(",")}]`;
  const sizes = node.sizes.map((s) => s.toFixed(2)).join(",");
  return `${node.direction}(${node.children.map(layoutSignature).join(" ")};${sizes})`;
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
  const results = node.children.map((child) => mapGroups(child, fn));
  const sizes = node.children.map((_, i) => node.sizes[i] ?? 1 / node.children.length);
  // A window that goes away gives its space to the window next to it (the one before it, or the
  // one after it for the first), as in VS Code. The other windows keep their size, so a window
  // that opens again in its last place gets its last size back (openPaneAt).
  results.forEach((r, i) => {
    if (r) return;
    const j = neighborIndex(results.map((x) => x !== null), i);
    if (j >= 0) sizes[j] += sizes[i];
  });
  const children: LayoutNode[] = [];
  const kept: number[] = [];
  results.forEach((r, i) => {
    if (r) {
      children.push(r);
      kept.push(sizes[i]);
    }
  });
  if (children.length === 0) return null;
  return { ...node, children, sizes: kept };
}

/** The index of the kept child next to child ``i``: the nearest one before it, else the nearest one after it. -1 if none. */
function neighborIndex(kept: boolean[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (kept[j]) return j;
  for (let j = i + 1; j < kept.length; j++) if (kept[j]) return j;
  return -1;
}

/** Where a pane was before it closed: the window next to it, the side, and its share of the two. */
export interface PaneSlot {
  neighborId: string; // The window or the split next to the pane.
  neighborPane: PaneId | null; // A pane in that window, if the id is gone.
  direction: "row" | "column";
  before: boolean; // The pane was before (left of, or above) its neighbor.
  share: number; // The share of the pane in the space of the two.
}

/** The slot of a pane that is alone in its window, to open it again in the same place (openPaneAt). */
export function paneSlot(node: LayoutNode, pane: PaneId): PaneSlot | null {
  if (node.type === "group") return null;
  const i = node.children.findIndex((c) => c.type === "group" && c.tabs.length === 1 && c.tabs[0] === pane);
  if (i >= 0) {
    const j = neighborIndex(node.children.map((_, k) => k !== i), i);
    if (j < 0) return null;
    const mine = node.sizes[i] ?? 0;
    const theirs = node.sizes[j] ?? 0;
    return {
      neighborId: node.children[j].id,
      neighborPane: groups(node.children[j])[0]?.tabs[0] ?? null,
      direction: node.direction,
      before: i < j,
      share: mine + theirs > 0 ? mine / (mine + theirs) : 0.5,
    };
  }
  for (const child of node.children) {
    const found = paneSlot(child, pane);
    if (found) return found;
  }
  return null;
}

function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  if (node.type === "group") return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function replaceNode(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return fn(node);
  if (node.type === "group") return node;
  return { ...node, children: node.children.map((c) => replaceNode(c, id, fn)) };
}

/**
 * Keeps the last place of each closed pane in ``slots``, and moves a pane that opens again back to
 * that place. Only a change of one pane counts: a close, or an open. A new layout (another session
 * or view) changes nothing. Returns ``next``, or the layout with the pane in its last place.
 */
export function reopenInSlot(prev: LayoutNode | null, next: LayoutNode, slots: Map<PaneId, PaneSlot>): LayoutNode {
  if (!prev || prev === next) return next;
  const before = new Set(groups(prev).flatMap((g) => g.tabs));
  const after = new Set(groups(next).flatMap((g) => g.tabs));
  const closed = [...before].filter((p) => !after.has(p));
  const opened = [...after].filter((p) => !before.has(p));
  if (closed.length === 1 && opened.length === 0) {
    const pane = closed[0];
    const slot = paneSlot(prev, pane);
    if (slot && layoutSignature(closePane(prev, pane)) === layoutSignature(next)) slots.set(pane, slot);
    return next;
  }
  if (opened.length === 1 && closed.length === 0) {
    const pane = opened[0];
    const slot = slots.get(pane);
    if (!slot) return next;
    const without = closePane(next, pane);
    if (layoutSignature(without) !== layoutSignature(prev)) return next;
    return openPaneAt(prev, pane, slot);
  }
  return next;
}

/** Opens a pane in its last place and size (a slot of paneSlot). Without the place, as openPane. */
export function openPaneAt(node: LayoutNode, pane: PaneId, slot: PaneSlot): LayoutNode {
  if (findGroupOf(node, pane)) return activate(node, pane);
  const target = findNode(node, slot.neighborId) ?? (slot.neighborPane ? findGroupOf(node, slot.neighborPane) : null);
  if (!target) return openPane(node, pane);
  const share = Math.min(0.9, Math.max(0.1, slot.share));
  const placed = replaceNode(node, target.id, (n) => {
    const fresh = group([pane]);
    return slot.before ? split(slot.direction, [fresh, n], [share, 1 - share]) : split(slot.direction, [n, fresh], [1 - share, share]);
  });
  const result = normalize(placed);
  return chatHasFullHeight(result) ? result : openPane(node, pane);
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
