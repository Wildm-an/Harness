// The annotation bar, as in the Claude app: a row under the page of the Browser pane. The pane gives
// it its own space, so the page gets smaller and the bar covers no part of the page. Each choice
// goes to the page script (annotate.ts), which draws the marks.

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  Eraser,
  ImagePlus,
  LoaderCircle,
  MousePointer2,
  MoveUpRight,
  Pen,
  Slash,
  Square,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { COLORS, SHAPES, WIDTHS, usesColor, usesWidth, type AnnotateTool, type ShapeTool } from "./annotate";

/** The step icon: a circle with the number 1. */
function StepIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor" stroke="none">
        1
      </text>
    </svg>
  );
}

const SHAPE_ICONS: Record<ShapeTool, LucideIcon | typeof StepIcon> = {
  line: Slash,
  arrow: MoveUpRight,
  rect: Square,
  ellipse: Circle,
  step: StepIcon,
};

/** A line with the thickness of a line width, for the width button and its menu. */
function WidthLine({ px, long = false }: { px: number; long?: boolean }) {
  return <span className="annotate-wline" style={{ height: Math.max(2, Math.min(px, 10)), width: long ? 28 : 18 }} />;
}

export interface AnnotateBarProps {
  tool: AnnotateTool;
  shape: ShapeTool; // The shape of the shape button: the last shape that the user chose.
  color: string;
  width: number;
  busy: boolean; // The screenshot of "Add to prompt" is in progress.
  capture: boolean; // False: "Add to prompt" needs the desktop app.
  onTool: (tool: AnnotateTool) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onClear: () => void;
  onAdd: () => void;
  onDone: () => void;
}

type MenuId = "shape" | "color" | "width";

export function AnnotateBar(props: AnnotateBarProps) {
  const { tool, shape, color, width, busy, capture } = props;
  const [menu, setMenu] = useState<MenuId | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A menu opens up over the page: the webview hides, and a still picture of the page shows.
  useOverlay(menu !== null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMenu(null);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  const pick = (next: AnnotateTool) => {
    setMenu(null);
    props.onTool(tool === next ? "none" : next);
  };
  const toggle = (id: MenuId) => setMenu((m) => (m === id ? null : id));
  const isShape = SHAPES.some((s) => s.id === tool);
  const current = SHAPES.find((s) => s.id === shape) ?? SHAPES[2];
  const ShapeIcon = SHAPE_ICONS[current.id];
  const widthName = (WIDTHS.find(([w]) => w === width) ?? WIDTHS[1])[1];
  const colorName = (COLORS.find(([c]) => c === color) ?? COLORS[0])[1];

  const toolButton = (id: AnnotateTool, label: string, Icon: LucideIcon) => (
    <button
      type="button"
      className={`annotate-tool${tool === id ? " active" : ""}`}
      aria-pressed={tool === id}
      aria-label={label}
      title={label}
      onClick={() => pick(id)}
    >
      <Icon size={15} aria-hidden />
    </button>
  );
  const menuButton = (id: MenuId, label: string, inner: React.ReactNode, active = false) => (
    <button
      type="button"
      className={`annotate-tool${active ? " active" : ""}`}
      aria-haspopup="menu"
      aria-expanded={menu === id}
      aria-label={label}
      title={menu ? undefined : label}
      onClick={() => toggle(id)}
    >
      {inner}
      <ChevronDown size={12} aria-hidden />
    </button>
  );

  return (
    <div
      className="annotate-bar"
      ref={ref}
      role="toolbar"
      aria-label="Annotate"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (menu) setMenu(null);
        else props.onDone();
      }}
    >
      <div className="annotate-tools">
        {toolButton("select", "Select an element and add a note", MousePointer2)}
        {toolButton("pen", "Pen", Pen)}
        <div className="annotate-mwrap">
          {menuButton("shape", `Shape: ${current.label}`, <ShapeIcon size={15} aria-hidden />, isShape)}
          {menu === "shape" && (
            <div className="menu annotate-menu" role="menu" aria-label="Shape">
              {SHAPES.map((s) => {
                const Icon = SHAPE_ICONS[s.id];
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={tool === s.id}
                    onClick={() => {
                      setMenu(null);
                      props.onTool(s.id);
                    }}
                  >
                    <Icon size={15} aria-hidden />
                    <span className="side-filter-label">{s.label}</span>
                    {tool === s.id && <Check size={14} aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {toolButton("text", "Text", Type)}
        {usesColor(tool) && (
          <>
            <span className="annotate-sep" aria-hidden />
            <div className="annotate-mwrap">
              {menuButton("color", `Color: ${colorName}`, <span className="annotate-dot" style={{ background: color }} />)}
              {menu === "color" && (
                <div className="menu annotate-menu" role="menu" aria-label="Color">
                  <div className="annotate-colors">
                    {COLORS.map(([value, name]) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={color === value}
                        aria-label={name}
                        title={name}
                        className={`annotate-swatch${color === value ? " active" : ""}`}
                        style={{ background: value }}
                        onClick={() => {
                          setMenu(null);
                          props.onColor(value);
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        {usesWidth(tool) && (
          <div className="annotate-mwrap">
            {menuButton("width", `Line width: ${widthName}`, <WidthLine px={width} />)}
            {menu === "width" && (
              <div className="menu annotate-menu" role="menu" aria-label="Line width">
                {WIDTHS.map(([value, name]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={width === value}
                    aria-label={name}
                    onClick={() => {
                      setMenu(null);
                      props.onWidth(value);
                    }}
                  >
                    <WidthLine px={value} long />
                    <span className="side-filter-label">{name}</span>
                    {width === value && <Check size={14} aria-hidden />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="annotate-sep" aria-hidden />
        <button type="button" className="annotate-tool" aria-label="Undo the last mark" title="Undo the last mark" onClick={props.onUndo}>
          <Undo2 size={15} aria-hidden />
        </button>
        <button type="button" className="annotate-tool" aria-label="Clear all marks" title="Clear all marks" onClick={props.onClear}>
          <Eraser size={15} aria-hidden />
        </button>
        <span className="annotate-sep" aria-hidden />
        <button
          type="button"
          className={`btn btn-small btn-primary annotate-add${busy ? " busy" : ""}`}
          disabled={busy || !capture}
          aria-label="Add to prompt"
          title={capture ? "Put a screenshot of the page with the marks into the prompt" : "The screenshot needs the desktop app"}
          onClick={props.onAdd}
        >
          {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <ImagePlus size={13} aria-hidden />}
          <span className="annotate-add-text">Add to prompt</span>
        </button>
        <button type="button" className="annotate-tool" aria-label="Done" title="Done (Esc)" onClick={props.onDone}>
          <X size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}
