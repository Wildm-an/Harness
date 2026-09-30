// The pane layout (SPEC.md section 8.4): tab groups in nested rows and columns.
// All functions are pure. Each one returns a new layout.

export type PaneId = "chat" | "editor" | "browser" | "servers" | "diff" | "rules" | "skills" | "mcp" | "terminal";
export const PANE_IDS: PaneId[] = ["chat", "editor", "browser", "servers", "diff", "rules", "skills", "mcp", "terminal"];

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

export function group(tabs: PaneId[], active?: PaneId): Group {
  return { type: "group", id: newId("g"), tabs, active: active ?? tabs[0] };
}

function split(direction: Split["direction"], children: LayoutNode[], sizes?: number[]): Split {
  return { type: "split", id: newId("s"), direction, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

/** Chat on the left. The editor and the browser as tabs on the right (SPEC.md section 8.4). */
export function defaultLayout(): LayoutNode {
  return split("row", [group(["chat"]), group(["editor", "browser"], "editor")], [0.45, 0.55]);
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

/** Removes empty groups and splits with one child. The sizes of each split add up to 1. */
export function normalize(node: LayoutNode | null): LayoutNode {
  if (!node) return defaultLayout();
  const clean = (n: LayoutNode): LayoutNode | null => {
    if (n.type === "group") {
      const tabs = n.tabs.filter((t, i) => PANE_IDS.includes(t) && n.tabs.indexOf(t) === i);
      if (tabs.length === 0) return null;
      return { ...n, tabs, active: tabs.includes(n.active) ? n.active : tabs[0] };
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
 * Shows a pane. A pane that is in the layout becomes the active tab of its group. A new pane
 * goes into ``targetGroupId``, or into the first group that has no chat, or into a new group
 * on the right.
 */
export function openPane(node: LayoutNode, pane: PaneId, targetGroupId?: string): LayoutNode {
  if (findGroupOf(node, pane)) return activate(node, pane);
  const all = groups(node);
  const target = all.find((g) => g.id === targetGroupId) ?? all.find((g) => !g.tabs.includes("chat"));
  if (!target) return normalize(split("row", [node, group([pane])], [0.5, 0.5]));
  return normalize(mapGroups(node, (g) => (g.id === target.id ? { ...g, tabs: [...g.tabs, pane], active: pane } : g)));
}

/**
 * Shows a pane in a new group below the group of ``anchor`` (for example the terminal below the
 * chat). A pane that is in the layout becomes the active tab of its group.
 */
export function openBelow(node: LayoutNode, pane: PaneId, anchor: PaneId, share = 0.3): LayoutNode {
  if (findGroupOf(node, pane)) return activate(node, pane);
  const target = findGroupOf(node, anchor);
  if (!target) return openPane(node, pane);
  return normalize(
    mapGroups(node, (g) => (g.id === target.id ? split("column", [g, group([pane])], [1 - share, share]) : g)),
  );
}

/** Shows a pane, or closes it if it is the active tab of its group. */
export function togglePane(node: LayoutNode, pane: PaneId, show: (n: LayoutNode) => LayoutNode = (n) => openPane(n, pane)): LayoutNode {
  return findGroupOf(node, pane)?.active === pane ? closePane(node, pane) : show(node);
}

/** Moves a pane to a group ("center"), or to a new group at one side of that group. */
export function movePane(node: LayoutNode, pane: PaneId, targetGroupId: string, zone: Zone): LayoutNode {
  const source = findGroupOf(node, pane);
  const target = groups(node).find((g) => g.id === targetGroupId);
  if (!source || !target) return node;
  if (zone === "center" && source.id === target.id) return activate(node, pane);
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
    if (zone === "center") return { ...g, tabs: [...g.tabs, pane], active: pane };
    const fresh = group([pane]);
    const direction = zone === "left" || zone === "right" ? "row" : "column";
    const children = zone === "left" || zone === "top" ? [fresh, g] : [g, fresh];
    return split(direction, children, [0.5, 0.5]);
  });
  return normalize(placed);
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
