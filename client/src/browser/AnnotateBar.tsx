// The annotation bar under the page of the Browser pane: a small floating bar, as in the Claude app.
// Tools: element selection, a pen, shapes (line, arrow, rectangle, ellipse, numbered step), and text.
// No tool is on when the bar opens: the user picks one. The color and the line width show only for
// the tools that use them. The page script (annotate.ts) draws over the live page. "Add to prompt"
// puts a screenshot of the page with the marks into the prompt box.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Circle, Eraser, ImagePlus, LoaderCircle, MousePointer2, MoveUpRight, Pencil, Slash, Square, Type, Undo2, X } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export type AnnotateTool = "none" | "select" | "pen" | "line" | "arrow" | "rect" | "ellipse" | "step" | "text";
export type ShapeTool = "line" | "arrow" | "rect" | "ellipse" | "step";

function StepIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
        1
      </text>
    </svg>
  );
}

export const SHAPES: { id: ShapeTool; label: string; icon: (size: number) => ReactNode }[] = [
  { id: "line", label: "Line", icon: (s) => <Slash size={s} aria-hidden /> },
  { id: "arrow", label: "Arrow", icon: (s) => <MoveUpRight size={s} aria-hidden /> },
  { id: "rect", label: "Rectangle", icon: (s) => <Square size={s} aria-hidden /> },
  { id: "ellipse", label: "Ellipse", icon: (s) => <Circle size={s} aria-hidden /> },
  { id: "step", label: "Step", icon: (s) => <StepIcon size={s} /> },
];

export const COLORS: [string, string][] = [
  ["#e5484d", "Red"],
  ["#f76b15", "Orange"],
  ["#ffc53d", "Yellow"],
  ["#30a46c", "Green"],
  ["#2a78d6", "Blue"],
  ["#8e4ec6", "Purple"],
  ["#ffffff", "White"],
  ["#111111", "Black"],
];

/** The line widths of the pen and the shapes, in pixels. */
export const WIDTHS: [number, string][] = [
  [2, "Thin"],
  [4, "Medium"],
  [7, "Thick"],
  [11, "Extra thick"],
];

/** The tools that use a color: the pen, the shapes, and text. */
export function usesColor(tool: AnnotateTool): boolean {
  return tool !== "none" && tool !== "select";
}

/** The tools that use a line width: the pen and the shapes that are lines (not the numbered step). */
export function usesWidth(tool: AnnotateTool): boolean {
  return usesColor(tool) && tool !== "text" && tool !== "step";
}

function WidthLine({ width }: { width: number }) {
  return <span className="annotate-width-line" style={{ height: Math.max(2, Math.min(width, 10)) }} aria-hidden />;
}

/** A menu that opens above its button. The page hides while it is open: the native page is over the app. */
function UpMenu({ label, button, active, children }: {
  label: string;
  button: ReactNode;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="annotate-menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className={`annotate-tool annotate-menu-btn${active ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {button}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="menu annotate-menu-list" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function AnnotateBar({
  tool,
  shape,
  color,
  width,
  busy,
  canCapture,
  onTool,
  onColor,
  onWidth,
  onUndo,
  onClear,
  onAdd,
  onClose,
}: {
  tool: AnnotateTool; // "none": no tool is on (the start).
  shape: ShapeTool; // The shape of the shape button: the last shape that the user chose.
  color: string;
  width: number; // The line width of the pen and the shapes.
  busy: boolean; // The screenshot is in progress.
  canCapture: boolean; // False: the screenshot needs the desktop app.
  onTool: (tool: AnnotateTool) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onClear: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const current = SHAPES.find((s) => s.id === shape) ?? SHAPES[2];
  const isShape = SHAPES.some((s) => s.id === tool);
  // A click on the tool that is on turns it off.
  const toolButton = (id: AnnotateTool, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={`annotate-tool${tool === id ? " active" : ""}`}
      aria-pressed={tool === id}
      aria-label={label}
      title={label}
      onClick={() => onTool(tool === id ? "none" : id)}
    >
      {icon}
    </button>
  );
  const widthName = WIDTHS.find(([w]) => w === width)?.[1] ?? "Medium";
  return (
    <div className="annotate-dock">
      <div className="annotate-bar" role="toolbar" aria-label="Annotate">
        {toolButton("select", "Select an element and add a note", <MousePointer2 size={15} aria-hidden />)}
        {toolButton("pen", "Pen", <Pencil size={15} aria-hidden />)}
        <UpMenu label={`Shape: ${current.label}`} button={current.icon(15)} active={isShape}>
          {(close) =>
            SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={tool === s.id}
                onClick={() => {
                  onTool(s.id);
                  close();
                }}
              >
                {s.icon(15)} {s.label}
              </button>
            ))
          }
        </UpMenu>
        {toolButton("text", "Text", <Type size={15} aria-hidden />)}
        {usesColor(tool) && (
          <>
            <span className="annotate-sep" aria-hidden />
            <UpMenu label="Color" button={<span className="annotate-color-dot" style={{ background: color }} aria-hidden />}>
              {(close) => (
                <div className="annotate-colors" role="group" aria-label="Colors">
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
                        onColor(value);
                        close();
                      }}
                    />
                  ))}
                </div>
              )}
            </UpMenu>
          </>
        )}
        {usesWidth(tool) && (
          <UpMenu label={`Line width: ${widthName}`} button={<WidthLine width={width} />}>
            {(close) =>
              WIDTHS.map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={width === value}
                  aria-label={name}
                  title={name}
                  className="annotate-width-item"
                  onClick={() => {
                    onWidth(value);
                    close();
                  }}
                >
                  <WidthLine width={value} />
                  <span className="annotate-width-check">{width === value && <Check size={14} aria-hidden />}</span>
                </button>
              ))
            }
          </UpMenu>
        )}
        <span className="annotate-sep" aria-hidden />
        <button type="button" className="annotate-tool" onClick={onUndo} aria-label="Undo the last mark" title="Undo the last mark">
          <Undo2 size={15} aria-hidden />
        </button>
        <button type="button" className="annotate-tool" onClick={onClear} aria-label="Clear all marks" title="Clear all marks">
          <Eraser size={15} aria-hidden />
        </button>
        <span className="annotate-sep" aria-hidden />
        <button
          type="button"
          className="btn btn-primary btn-small annotate-add"
          onClick={onAdd}
          disabled={busy || !canCapture}
          aria-label="Add to prompt"
          title={canCapture ? "Put a screenshot of the page with the marks into the prompt" : "The screenshot needs the desktop app"}
        >
          {/* A narrow pane shows only the icon, so that the bar stays one row. */}
          {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <ImagePlus size={13} aria-hidden className="annotate-add-icon" />}
          <span className="annotate-add-text">Add to prompt</span>
        </button>
        <button type="button" className="annotate-tool" onClick={onClose} aria-label="Done" title="Done (Esc in the page)">
          <X size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}
