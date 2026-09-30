import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X, type LucideIcon } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import {
  canMove,
  closePane,
  groups,
  movePane,
  resize,
  setSideShare,
  sideShareOf,
  type Group,
  type LayoutNode,
  type PaneId,
  type Split,
  type Zone,
} from "./model";

// The width of the windows beside the chat, in pixels. It stays for all projects and after a restart.
const SIDE_WIDTH_PREF = "layout.sideWidth";

export interface PaneSpec {
  title: string;
  icon: LucideIcon;
  closable: boolean;
  render: () => ReactNode;
  badge?: ReactNode;
  // The pane puts its own content in the window header with <PaneHeader>, for example its tabs.
  // The header then shows no title.
  ownHeader?: boolean;
}

const DRAG_TYPE = "application/x-harness-pane";
const MIN_SHARE = 0.08;
const MIN_PX = 240; // A pane narrower than this is hard to use.
const KEY_STEP = 0.04;

// The places in the window header for the content of the pane: its tabs, and its buttons.
const HeaderSlots = createContext<{ main: HTMLElement | null; actions: HTMLElement | null } | null>(null);

/** Content of a pane in its window header, on the left: for example the tabs of the pane. */
export function PaneHeader({ children }: { children: ReactNode }) {
  const slots = useContext(HeaderSlots);
  return slots?.main ? createPortal(children, slots.main) : null;
}

/** Buttons of a pane in its window header, on the right, before the window buttons. */
export function PaneActions({ children }: { children: ReactNode }) {
  const slots = useContext(HeaderSlots);
  return slots?.actions ? createPortal(children, slots.actions) : null;
}

/** The side of the window under the pointer. The center is not a drop zone: a window shows one pane. */
function zoneAt(e: React.DragEvent, el: HTMLElement): Zone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edges: [Zone, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

function GroupView({
  group,
  root,
  panes,
  onChange,
  dragging,
  setDragging,
  maximized,
  onMaximize,
}: {
  group: Group;
  root: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  onChange: (l: LayoutNode) => void;
  dragging: PaneId | null;
  setDragging: (p: PaneId | null) => void;
  maximized: boolean;
  onMaximize: ((on: boolean) => void) | null; // null: the window cannot fill the workspace (it is the only one).
}) {
  const [zone, setZone] = useState<Zone | null>(null);
  const [main, setMain] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const spec = panes[group.active];
  const chatOnly = group.tabs.length === 1 && group.tabs[0] === "chat";
  const tabbed = group.tabs.length > 1; // Only the narrow view has more panes in one window.

  const select = (pane: PaneId) => onChange(replaceGroup(root, group.id, { ...group, active: pane }));

  const drop = (e: React.DragEvent, z: Zone) => {
    e.preventDefault();
    const pane = e.dataTransfer.getData(DRAG_TYPE) as PaneId;
    setZone(null);
    setDragging(null);
    if (pane) onChange(movePane(root, pane, group.id, z));
  };

  const Icon = spec.icon;
  return (
    // The chat alone in a window needs no header, as in the Claude Code desktop app.
    <section
      className={`pane-group${chatOnly ? " chat-only" : " pane-window"}${maximized ? " is-max" : ""}`}
      aria-label={`${spec.title} pane`}
    >
      {!chatOnly && (
        <div
          className="win-head"
          draggable={!tabbed}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, group.active);
            e.dataTransfer.effectAllowed = "move";
            setDragging(group.active);
          }}
          onDragEnd={() => setDragging(null)}
          onDoubleClick={(e) => {
            if (onMaximize && !(e.target as HTMLElement).closest("button, input")) onMaximize(!maximized);
          }}
        >
          {tabbed ? (
            <div className="win-panes" role="tablist">
              {group.tabs.map((pane) => {
                const TabIcon = panes[pane].icon;
                return (
                  <button
                    key={pane}
                    type="button"
                    role="tab"
                    aria-selected={pane === group.active}
                    className={`win-pane${pane === group.active ? " active" : ""}`}
                    onClick={() => select(pane)}
                  >
                    <TabIcon size={13} aria-hidden />
                    {panes[pane].title}
                    {panes[pane].badge}
                  </button>
                );
              })}
            </div>
          ) : (
            !spec.ownHeader && (
              <span className="win-title" title="Drag to move the window">
                <Icon size={13} aria-hidden />
                {spec.title}
                {spec.badge}
              </span>
            )
          )}
          <div className="win-slot" ref={setMain} />
          <div className="win-actions" ref={setActions} />
          {onMaximize && !tabbed && (
            <button
              type="button"
              className="icon-btn ghost win-btn"
              onClick={() => onMaximize(!maximized)}
              aria-label={maximized ? "Restore the window" : "Fill the workspace"}
              title={maximized ? "Restore" : "Fill the workspace"}
            >
              {maximized ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            </button>
          )}
          {spec.closable && (
            <button
              type="button"
              className="icon-btn ghost win-btn"
              onClick={() => onChange(closePane(root, group.active))}
              aria-label={`Close the ${spec.title} pane`}
              title="Close"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
      )}
      <div
        className="pane-body"
        ref={body}
        onDragOver={(e) => {
          if (!dragging || !body.current) return;
          const z = zoneAt(e, body.current);
          // No drop zone above or below the chat.
          if (!canMove(root, dragging, group.id, z)) {
            setZone(null);
            return;
          }
          e.preventDefault();
          setZone(z);
        }}
        onDragLeave={(e) => {
          if (!body.current?.contains(e.relatedTarget as Node)) setZone(null);
        }}
        onDrop={(e) => body.current && drop(e, zoneAt(e, body.current))}
      >
        {group.tabs.map((pane) => (
          <div key={pane} role="tabpanel" className="pane-content" hidden={pane !== group.active}>
            <HeaderSlots.Provider value={pane === group.active ? { main, actions } : null}>{panes[pane].render()}</HeaderSlots.Provider>
          </div>
        ))}
        {dragging && zone && <div className={`drop-zone zone-${zone}`} aria-hidden />}
      </div>
    </section>
  );
}

function replaceGroup(node: LayoutNode, id: string, next: Group): LayoutNode {
  if (node.type === "group") return node.id === id ? next : node;
  return { ...node, children: node.children.map((c) => replaceGroup(c, id, next)) };
}

function SplitView(props: {
  node: Split;
  root: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  onChange: (l: LayoutNode) => void;
  dragging: PaneId | null;
  setDragging: (p: PaneId | null) => void;
  maxId: string | null;
  onMaximize: ((id: string, on: boolean) => void) | null;
}) {
  const { node, root, onChange, maxId } = props;
  const container = useRef<HTMLDivElement>(null);
  const row = node.direction === "row";

  const setPair = (i: number, first: number) => {
    const pair = node.sizes[i] + node.sizes[i + 1];
    const rect = container.current?.getBoundingClientRect();
    const total = rect ? (row ? rect.width : rect.height) : 0;
    const min = Math.min(Math.max(MIN_SHARE, total ? (row ? MIN_PX : MIN_PX / 2) / total : 0), pair / 2);
    const a = Math.min(Math.max(first, min), pair - min);
    const sizes = [...node.sizes];
    sizes[i] = a;
    sizes[i + 1] = pair - a;
    onChange(resize(root, node.id, sizes));
  };

  const startDrag = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rect = container.current!.getBoundingClientRect();
    const total = row ? rect.width : rect.height;
    const before = node.sizes.slice(0, i).reduce((a, b) => a + b, 0);
    const move = (ev: PointerEvent) => {
      const pos = ((row ? ev.clientX - rect.left : ev.clientY - rect.top) / total) - before;
      setPair(i, pos);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <div className={`split-view ${node.direction}`} ref={container}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div
            className="split-cell"
            // A share below 1 with no siblings does not fill the split: the filled window gets all the space.
            style={{ flexGrow: maxId !== null ? 1 : node.sizes[i], flexBasis: 0 }}
            hidden={maxId !== null && !hasGroup(child, maxId)} // Another window fills the workspace.
          >
            <NodeView {...props} node={child} />
          </div>
          {i < node.children.length - 1 && maxId === null && (
            <div
              className="split-handle"
              role="separator"
              aria-orientation={row ? "vertical" : "horizontal"}
              aria-label="Resize the panes"
              aria-valuenow={Math.round(node.sizes[i] * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              onPointerDown={startDrag(i)}
              onKeyDown={(e) => {
                const back = row ? "ArrowLeft" : "ArrowUp";
                const forward = row ? "ArrowRight" : "ArrowDown";
                if (e.key !== back && e.key !== forward) return;
                e.preventDefault();
                setPair(i, node.sizes[i] + (e.key === forward ? KEY_STEP : -KEY_STEP));
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function NodeView(props: {
  node: LayoutNode;
  root: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  onChange: (l: LayoutNode) => void;
  dragging: PaneId | null;
  setDragging: (p: PaneId | null) => void;
  maxId: string | null;
  onMaximize: ((id: string, on: boolean) => void) | null;
}) {
  const { node, maxId, onMaximize } = props;
  if (node.type === "split") return <SplitView {...props} node={node} />;
  return (
    <GroupView
      {...props}
      group={node}
      maximized={maxId === node.id}
      onMaximize={onMaximize && ((on: boolean) => onMaximize(node.id, on))}
    />
  );
}

/** True if a node has the window ``id``: the split cells on the way to a filled window stay. */
function hasGroup(node: LayoutNode, id: string): boolean {
  return node.type === "group" ? node.id === id : node.children.some((c) => hasGroup(c, id));
}

/**
 * The panes of the main window. On a narrow window, all panes are tabs of one group.
 */
export function Workspace({
  layout,
  onChange,
  panes,
  reveal,
}: {
  layout: LayoutNode;
  onChange: (l: LayoutNode) => void;
  panes: Record<PaneId, PaneSpec>;
  // A request to show a pane, for example "Open in terminal". A narrow window shows it also when the
  // layout does not change (the pane was already the active tab of its group).
  reveal?: { pane: PaneId; key: number } | null;
}) {
  const [dragging, setDragging] = useState<PaneId | null>(null);
  useOverlay(dragging !== null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [narrow]); // The narrow view has another element.

  // Remember the width of the side windows. With no side windows, the next side area opens at that width.
  useEffect(() => {
    if (width < 100 || window.matchMedia("(max-width: 900px)").matches) return;
    const share = sideShareOf(layout);
    if (share !== null) {
      setSideShare(share);
      savePref(SIDE_WIDTH_PREF, String(Math.round(share * width)));
      return;
    }
    const saved = Number(loadPref(SIDE_WIDTH_PREF, ""));
    if (saved > 0) setSideShare(saved / width);
  }, [layout, width]);
  // The window that fills the workspace. It ends when the window closes.
  const [maxed, setMaxed] = useState<string | null>(null);
  const all = groups(layout);
  const maxId = maxed && all.length > 1 && all.some((g) => g.id === maxed) ? maxed : null;
  const onMaximize = all.length > 1 ? (id: string, on: boolean) => setMaxed(on ? id : null) : null;
  // The tab that the user selected on a narrow window. A layout change from elsewhere (a pane opens) replaces it.
  const [narrowTab, setNarrowTab] = useState<{ pane: PaneId; layout: LayoutNode } | null>(null);
  // The pane that became active last, for example after a shortcut. A narrow window shows it.
  const [opened, setOpened] = useState<PaneId | null>(null);
  const previous = useRef(layout);

  useEffect(() => {
    if (!reveal) return;
    setOpened(reveal.pane);
    setNarrowTab(null);
  }, [reveal]);

  useEffect(() => {
    const before = new Set(groups(previous.current).map((g) => g.active));
    previous.current = layout;
    const pane = groups(layout).map((g) => g.active).find((p) => !before.has(p));
    if (pane) {
      setOpened(pane);
      setMaxed(null);
    }
  }, [layout]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (narrow) {
    const all = groups(layout);
    const tabs = all.flatMap((g) => g.tabs);
    const focused = all.find((g) => g.tabs.includes("chat") && g.active !== "chat") ?? all[all.length - 1];
    const chosen =
      narrowTab && narrowTab.layout === layout && tabs.includes(narrowTab.pane) ? narrowTab.pane
      : opened && tabs.includes(opened) ? opened
      : focused.active;
    const single: Group = { type: "group", id: "narrow", tabs, active: chosen };
    return (
      <div className="workspace" ref={box}>
        <GroupView
          group={single}
          root={single}
          panes={panes}
          onChange={(next) => {
            // Keep the saved layout. Only the active pane changes.
            if (next.type === "group" && next.id === "narrow") {
              const target = all.find((g) => g.tabs.includes(next.active));
              if (target) {
                const updated = replaceGroup(layout, target.id, { ...target, active: next.active });
                setNarrowTab({ pane: next.active, layout: updated });
                onChange(updated);
              }
            }
          }}
          dragging={null}
          setDragging={() => undefined}
          maximized={false}
          onMaximize={null}
        />
      </div>
    );
  }

  return (
    <div className="workspace" ref={box}>
      <NodeView
        node={layout}
        root={layout}
        panes={panes}
        onChange={onChange}
        dragging={dragging}
        setDragging={setDragging}
        maxId={maxId}
        onMaximize={onMaximize}
      />
    </div>
  );
}
