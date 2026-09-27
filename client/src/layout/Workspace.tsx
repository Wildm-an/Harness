import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Columns2, EllipsisVertical, MoveRight, Rows2, X, type LucideIcon } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { closePane, groups, movePane, resize, type Group, type LayoutNode, type PaneId, type Split, type Zone } from "./model";

export interface PaneSpec {
  title: string;
  icon: LucideIcon;
  closable: boolean;
  render: () => ReactNode;
  badge?: ReactNode;
}

const DRAG_TYPE = "application/x-harness-pane";
const MIN_SHARE = 0.08;
const MIN_PX = 240; // A pane narrower than this is hard to use.
const KEY_STEP = 0.04;

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
  const [zone, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return distance < 0.25 ? zone : "center";
}

function GroupMenu({
  group,
  groupCount,
  pane,
  closable,
  onAction,
}: {
  group: Group;
  groupCount: number;
  pane: PaneId;
  closable: boolean;
  onAction: (action: "right" | "bottom" | "next" | "close") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const canSplit = group.tabs.length > 1;
  const run = (action: "right" | "bottom" | "next" | "close") => {
    setOpen(false);
    onAction(action);
  };

  return (
    <div className="group-menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className="icon-btn ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Pane actions"
        aria-label={`Actions for the ${pane} pane`}
      >
        <EllipsisVertical size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" disabled={!canSplit} onClick={() => run("right")}>
            <Columns2 size={14} aria-hidden /> Split right
          </button>
          <button type="button" role="menuitem" disabled={!canSplit} onClick={() => run("bottom")}>
            <Rows2 size={14} aria-hidden /> Split down
          </button>
          <button type="button" role="menuitem" disabled={groupCount < 2} onClick={() => run("next")}>
            <MoveRight size={14} aria-hidden /> Move to the next group
          </button>
          <button type="button" role="menuitem" disabled={!closable} onClick={() => run("close")}>
            <X size={14} aria-hidden /> Close
          </button>
        </div>
      )}
    </div>
  );
}

function GroupView({
  group,
  root,
  panes,
  onChange,
  dragging,
  setDragging,
}: {
  group: Group;
  root: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  onChange: (l: LayoutNode) => void;
  dragging: PaneId | null;
  setDragging: (p: PaneId | null) => void;
}) {
  const [zone, setZone] = useState<Zone | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const all = groups(root);

  const select = (pane: PaneId) => onChange(replaceGroup(root, group.id, { ...group, active: pane }));

  const drop = (e: React.DragEvent, z: Zone) => {
    e.preventDefault();
    const pane = e.dataTransfer.getData(DRAG_TYPE) as PaneId;
    setZone(null);
    setDragging(null);
    if (pane) onChange(movePane(root, pane, group.id, z));
  };

  const action = (a: "right" | "bottom" | "next" | "close") => {
    const pane = group.active;
    if (a === "close") onChange(closePane(root, pane));
    else if (a === "next") {
      const index = all.findIndex((g) => g.id === group.id);
      onChange(movePane(root, pane, all[(index + 1) % all.length].id, "center"));
    } else onChange(movePane(root, pane, group.id, a));
  };

  return (
    <section className="pane-group" aria-label={`${panes[group.active].title} pane group`}>
      <div
        className="pane-tabs"
        role="tablist"
        onDragOver={(e) => dragging && (e.preventDefault(), setZone("center"))}
        onDrop={(e) => drop(e, "center")}
      >
        {group.tabs.map((pane) => {
          const spec = panes[pane];
          const Icon = spec.icon;
          const selected = pane === group.active;
          return (
            <div key={pane} className={`pane-tab${selected ? " active" : ""}`} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, pane);
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(pane);
                }}
                onDragEnd={() => setDragging(null)}
                onClick={() => select(pane)}
                title="Drag to move or split"
              >
                <Icon size={13} aria-hidden />
                {spec.title}
                {spec.badge}
              </button>
              {spec.closable && (
                <button
                  type="button"
                  className="pane-tab-close"
                  onClick={() => onChange(closePane(root, pane))}
                  aria-label={`Close the ${spec.title} pane`}
                  title="Close"
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </div>
          );
        })}
        <span className="spacer" />
        <GroupMenu
          group={group}
          groupCount={all.length}
          pane={group.active}
          closable={panes[group.active].closable}
          onAction={action}
        />
      </div>
      <div
        className="pane-body"
        ref={body}
        onDragOver={(e) => {
          if (!dragging || !body.current) return;
          e.preventDefault();
          setZone(zoneAt(e, body.current));
        }}
        onDragLeave={(e) => {
          if (!body.current?.contains(e.relatedTarget as Node)) setZone(null);
        }}
        onDrop={(e) => body.current && drop(e, zoneAt(e, body.current))}
      >
        {group.tabs.map((pane) => (
          <div key={pane} role="tabpanel" className="pane-content" hidden={pane !== group.active}>
            {panes[pane].render()}
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

function SplitView({
  node,
  root,
  panes,
  onChange,
  dragging,
  setDragging,
}: {
  node: Split;
  root: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
  onChange: (l: LayoutNode) => void;
  dragging: PaneId | null;
  setDragging: (p: PaneId | null) => void;
}) {
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
          <div className="split-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <NodeView node={child} root={root} panes={panes} onChange={onChange} dragging={dragging} setDragging={setDragging} />
          </div>
          {i < node.children.length - 1 && (
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
}) {
  return props.node.type === "group" ? <GroupView {...props} group={props.node} /> : <SplitView {...props} node={props.node} />;
}

/**
 * The panes of the main window. On a narrow window, all panes are tabs of one group.
 */
export function Workspace({
  layout,
  onChange,
  panes,
}: {
  layout: LayoutNode;
  onChange: (l: LayoutNode) => void;
  panes: Record<PaneId, PaneSpec>;
}) {
  const [dragging, setDragging] = useState<PaneId | null>(null);
  useOverlay(dragging !== null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  // The tab that the user selected on a narrow window. A layout change from elsewhere (a pane opens) replaces it.
  const [narrowTab, setNarrowTab] = useState<{ pane: PaneId; layout: LayoutNode } | null>(null);

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
    const chosen = narrowTab && narrowTab.layout === layout && tabs.includes(narrowTab.pane) ? narrowTab.pane : focused.active;
    const single: Group = { type: "group", id: "narrow", tabs, active: chosen };
    return (
      <div className="workspace">
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
        />
      </div>
    );
  }

  return (
    <div className="workspace">
      <NodeView node={layout} root={layout} panes={panes} onChange={onChange} dragging={dragging} setDragging={setDragging} />
    </div>
  );
}
