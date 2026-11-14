// The Preview pane: a PDF (pdf.js) or a Word file (docx-preview) of the session folder, read only.
// The user opens it from the file tree or from a path in the chat. The agent opens it with the
// show_document tool. The daemon sends the bytes with "fs.read_bytes" (the Content Security Policy
// of the app allows no HTTP fetch from the daemon). Both renderers are part of the app bundle, so
// the pane works offline.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, Maximize, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { PaneActions, PaneHeader } from "../layout/Workspace";
import { baseName } from "../chat/toolText";
import { fitWidthZoom, linkAction, previewKind, stepZoom, type PreviewDoc } from "./document";
import { paginateDocx } from "./paginate";

// pdf.js loads only when the first PDF opens: it is large.
type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return pdfjsPromise;
}

const PDFJS_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pdfjs/`;

export function PreviewPane({
  doc,
  onReload,
  onOpenLink,
}: {
  doc: PreviewDoc | null;
  onReload: () => void; // Read the file from the daemon again.
  onOpenLink: (url: string) => void; // A web link of a Word file.
}) {
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pages, setPages] = useState(0);
  const kind = doc ? previewKind(doc.path) : null;

  // A new file starts at the page width.
  useEffect(() => {
    setZoom("fit");
    setPages(0);
  }, [doc?.path]);

  if (!doc) {
    return (
      <p className="pane-empty">
        <FileText size={16} aria-hidden />
        No document open. Click a PDF or Word file in Files, or a path in the chat.
      </p>
    );
  }

  return (
    <div className="preview-pane">
      <PaneHeader>
        <span className="preview-name" title={doc.path}>
          {baseName(doc.path)}
        </span>
      </PaneHeader>
      <PaneActions>
        {doc.status === "ready" && pages > 0 && (
          <span className="preview-pages">{pages === 1 ? "1 page" : `${pages} pages`}</span>
        )}
        {kind === "pdf" && doc.status === "ready" && (
          <>
            <button
              type="button"
              className="icon-btn ghost win-btn"
              onClick={() => setZoom((z) => stepZoom(z === "fit" ? 1 : z, -1))}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <ZoomOut size={15} aria-hidden />
            </button>
            <button
              type="button"
              className={`icon-btn ghost win-btn${zoom === "fit" ? " active" : ""}`}
              onClick={() => setZoom("fit")}
              aria-label="Fit to width"
              aria-pressed={zoom === "fit"}
              title="Fit to width"
            >
              <Maximize size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn ghost win-btn"
              onClick={() => setZoom((z) => stepZoom(z === "fit" ? 1 : z, 1))}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <ZoomIn size={15} aria-hidden />
            </button>
          </>
        )}
        <button type="button" className="icon-btn ghost win-btn" onClick={onReload} aria-label="Reload" title="Reload">
          <RotateCw size={15} aria-hidden />
        </button>
      </PaneActions>
      {doc.status === "loading" && (
        <p className="pane-empty">
          <LoaderCircle size={16} className="spin" aria-hidden />
          Loading {baseName(doc.path)}…
        </p>
      )}
      {doc.status === "error" && (
        <p className="pane-empty preview-error" role="alert">
          Couldn't open {baseName(doc.path)}. {doc.error}
        </p>
      )}
      {doc.status === "ready" && kind === "pdf" && (
        <PdfView key={doc.path} data={doc.data} zoom={zoom} onZoom={setZoom} onPages={setPages} />
      )}
      {doc.status === "ready" && kind === "docx" && (
        <DocxView key={doc.path} data={doc.data} onOpenLink={onOpenLink} onPages={setPages} />
      )}
    </div>
  );
}

function ErrorText({ text }: { text: string }) {
  return (
    <p className="pane-empty preview-error" role="alert">
      {text}
    </p>
  );
}

/** All pages of a PDF in a column. A page draws when it comes near the visible part of the pane. */
function PdfView({
  data,
  zoom,
  onZoom,
  onPages,
}: {
  data: Uint8Array;
  zoom: number | "fit";
  onZoom: (zoom: number) => void;
  onPages: (count: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageWidth, setPageWidth] = useState(0); // The width of page 1 at zoom 1, in CSS pixels.
  const [paneWidth, setPaneWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    setError(null);
    void loadPdfJs()
      .then(async (lib) => {
        // pdf.js moves the buffer to its worker: give it a copy, so a reload can use the data again.
        const loading = lib.getDocument({
          data: data.slice(),
          cMapUrl: `${PDFJS_BASE}cmaps/`,
          standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
          wasmUrl: `${PDFJS_BASE}wasm/`,
          iccUrl: `${PDFJS_BASE}iccs/`,
          useWasm: false, // The Content Security Policy blocks WebAssembly. The JS decoders work.
          disableWorkerRendering: true,
        });
        task = loading;
        if (cancelled) return void loading.destroy();
        const loaded = await loading.promise;
        const first = await loaded.getPage(1);
        if (cancelled) return;
        setPageWidth(first.getViewport({ scale: 1 }).width);
        setPdf(loaded);
        onPages(loaded.numPages);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error && e.name === "PasswordException"
          ? "The PDF has a password. The Preview pane cannot open it."
          : `The PDF cannot be read: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPaneWidth(el.clientWidth));
    observer.observe(el);
    setPaneWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [pdf]);

  const scale = zoom === "fit" ? fitWidthZoom(paneWidth, pageWidth) : zoom;

  // Ctrl+wheel zooms, as in a browser PDF viewer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onZoom(stepZoom(scale, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, onZoom, pdf]);

  if (error) return <ErrorText text={error} />;
  if (!pdf || !pageWidth) {
    return (
      <p className="pane-empty">
        <LoaderCircle size={16} className="spin" aria-hidden /> Loading…
      </p>
    );
  }
  return (
    <div className="preview-scroll preview-pdf" ref={scroller} tabIndex={0} aria-label="PDF pages">
      {Array.from({ length: pdf.numPages }, (_, i) => (
        <PdfPage key={i} pdf={pdf} number={i + 1} scale={scale} root={scroller} />
      ))}
    </div>
  );
}

function PdfPage({
  pdf,
  number,
  scale,
  root,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [near, setNear] = useState(number <= 2);
  // The size before the page loads: the size of page 1. Most PDFs have one page size.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void pdf.getPage(number).then((p) => {
      if (cancelled) return;
      setPage(p);
    });
    if (number > 1) {
      void pdf.getPage(1).then((p) => {
        if (!cancelled) setSize((s) => s ?? p.getViewport({ scale: 1 }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [pdf, number]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root: root.current,
      rootMargin: "100% 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  const viewport = page?.getViewport({ scale });
  const width = viewport?.width ?? (size ? size.width * scale : 0);
  const height = viewport?.height ?? (size ? size.height * scale : 0);

  useEffect(() => {
    if (!page || !viewport || !near || !canvas.current || !text.current) return;
    const ratio = window.devicePixelRatio || 1;
    const c = canvas.current;
    c.width = Math.floor(viewport.width * ratio);
    c.height = Math.floor(viewport.height * ratio);
    const task = page.render({
      canvas: c,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    let layer: { cancel: () => void } | null = null;
    const textBox = text.current;
    textBox.replaceChildren();
    void loadPdfJs().then((lib) => {
      if (!textBox.isConnected) return;
      const t = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: textBox, viewport });
      layer = t;
      void t.render().catch(() => undefined);
    });
    void task.promise.catch(() => undefined); // A cancelled render rejects.
    return () => {
      task.cancel();
      layer?.cancel();
    };
  }, [page, scale, near]);

  return (
    <div
      ref={box}
      className="preview-page"
      style={{
        width,
        height,
        ["--total-scale-factor" as string]: String(scale),
        ["--scale-round-x" as string]: "1px",
        ["--scale-round-y" as string]: "1px",
      }}
      aria-label={`Page ${number}`}
    >
      <canvas ref={canvas} style={{ width, height }} />
      <div ref={text} className="textLayer" />
    </div>
  );
}

/**
 * A Word file, drawn as pages by docx-preview. paginateDocx then breaks the pages at the bottom
 * margin, as Word does. A page that is wider than the pane gets smaller, so it fits the pane width.
 * Links do not change the app page.
 */
function DocxView({
  data,
  onOpenLink,
  onPages,
}: {
  data: Uint8Array;
  onOpenLink: (url: string) => void;
  onPages: (count: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const styles = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | string>("loading");
  const [pageWidth, setPageWidth] = useState(0); // The width of the widest page at zoom 1.
  const [paneWidth, setPaneWidth] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0); // The height of the pages at zoom 1.

  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = body.current;
    if (!el || !inner) return;
    // A ResizeObserver gives the size before the transform, so the scale does not change it.
    const observer = new ResizeObserver(() => {
      setPaneWidth(el.clientWidth);
      setBodyHeight(inner.offsetHeight);
    });
    observer.observe(el);
    observer.observe(inner);
    setPaneWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = body.current;
    const styleBox = styles.current;
    if (!target || !styleBox) return;
    let cancelled = false;
    setState("loading");
    void import("docx-preview")
      .then((lib) =>
        lib.renderAsync(data, target, styleBox, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderAltChunks: false, // An alt chunk is HTML: it does not run in the app.
          useBase64URL: true, // The Content Security Policy allows data: images, not blob: images.
          experimental: true, // Tab stops at their true positions.
        }),
      )
      .then(async () => {
        // The page breaks need the final layout: the fonts, the images, and the tab stops (docx-preview
        // sets them 500 ms after the render).
        await Promise.all([
          document.fonts.ready,
          ...[...target.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)),
          new Promise((resolve) => setTimeout(resolve, 600)),
        ]);
        if (cancelled) return;
        paginateDocx(target);
        const pages = [...target.querySelectorAll<HTMLElement>("section.docx")];
        setPageWidth(Math.max(0, ...pages.map((page) => page.offsetWidth)));
        onPages(pages.length);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!cancelled) setState(`The Word file cannot be read: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      setPageWidth(0);
      target.replaceChildren();
      styleBox.replaceChildren();
    };
  }, [data]);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      e.preventDefault();
      const action = linkAction(a.getAttribute("href"));
      if (action?.kind === "external") onOpenLink(action.url);
      else if (action?.kind === "anchor") {
        const name = CSS.escape(action.id);
        body.current?.querySelector(`[id="${name}"], a[name="${name}"]`)?.scrollIntoView({ block: "start" });
      }
    },
    [onOpenLink],
  );

  const failed = state !== "loading" && state !== "ready";
  const zoom = pageWidth ? Math.min(1, fitWidthZoom(paneWidth, pageWidth)) : 1;
  // A narrow pane shows the pages smaller with a transform, not with CSS zoom: CSS zoom changes the
  // line breaks of the text, so the pages would not match the page breaks. The outer box gets the
  // size of the scaled pages, so the scroll bar is correct.
  const scaled = zoom < 1 && state === "ready";
  const fullWidth = pageWidth + 32; // The pages and the padding of the docx-preview wrapper.
  return (
    <div ref={scroller} className="preview-scroll preview-docx" tabIndex={0} aria-label="Word document" onClick={onClick}>
      {state === "loading" && (
        <p className="pane-empty">
          <LoaderCircle size={16} className="spin" aria-hidden /> Loading…
        </p>
      )}
      {failed && <ErrorText text={state} />}
      <div ref={styles} />
      <div
        hidden={failed}
        style={scaled ? { width: fullWidth * zoom, height: bodyHeight * zoom, margin: "0 auto", overflow: "hidden" } : undefined}
      >
        <div
          ref={body}
          style={{
            visibility: state === "loading" ? "hidden" : undefined,
            ...(scaled ? { width: fullWidth, transform: `scale(${zoom})`, transformOrigin: "0 0" } : {}),
          }}
        />
      </div>
    </div>
  );
}
