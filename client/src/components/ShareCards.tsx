// The chat cards of send_file and artifact (daemon tools/share.py), and of a page that the agent opened
// (preview_navigate), as the file, artifact, and browser cards of the Claude app. A sent file opens in a
// pane of the app, or in the default app of the computer. An artifact and a page open in the Browser pane.

import { memo, useEffect, useRef, useState } from "react";
import { AppWindow, Check, Copy, Ellipsis, ExternalLink, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, FolderOpen, Globe, PictureInPicture2, Presentation, SquareArrowOutUpRight, X } from "lucide-react";
import type { SentFile, ToolCardData } from "../daemon/protocol";
import { useOpenPath } from "../lib/openPath";
import { artifactUrl, fileKind, KIND_LABEL, openTarget, useCardActions, type FileKind } from "../lib/cardActions";
import { openExternal, openLocalPath, revealInExplorer } from "../lib/tauri";
import { useOverlay } from "../lib/overlay";
import { formatBytes } from "./StorageDialog";
import { splitPath } from "./FileCard";

const ICONS: Record<FileKind, typeof File> = {
  pdf: FileText,
  docx: FileText,
  image: FileImage,
  html: FileCode,
  sheet: FileSpreadsheet,
  slides: Presentation,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
  file: File,
};

function SentFileRow({ file, display }: { file: SentFile; display: "render" | "attach" | "auto" }) {
  const openPath = useOpenPath();
  const actions = useCardActions();
  const local = actions?.local ?? false;
  const kind = fileKind(file.name);
  const Icon = ICONS[kind];
  const target = openTarget(display, kind, file.project, local);
  const folder = file.project ? splitPath(file.path).folder : splitPath(file.abs).folder;
  const open = () => {
    if (target === "pane") openPath?.(file.path);
    else if (target === "app") void openLocalPath(file.abs).catch(() => undefined);
  };
  const where = target === "pane" ? "in the app" : "in its default app";
  return (
    <div className="file-card" role="group" aria-label={`File ${file.name}`}>
      <button type="button" className="file-card-main" onClick={open} disabled={target === "none" || (target === "pane" && !openPath)} title={`Open ${file.name} ${where}`}>
        <span className={`file-card-icon ${kind}`} aria-hidden>
          <Icon size={18} />
        </span>
        <span className="file-card-text">
          <span className="file-card-name">{file.name}</span>
          <span className="file-card-meta">
            {KIND_LABEL[kind]} · {formatBytes(file.size)}
            {folder && <span className="file-card-folder"> · {folder}</span>}
          </span>
        </span>
      </button>
      {local && (
        <button
          type="button"
          className="btn btn-small btn-ghost btn-icon"
          aria-label="Show in folder"
          title="Show in folder"
          onClick={() => void revealInExplorer(file.abs).catch(() => undefined)}
        >
          <FolderOpen size={14} aria-hidden />
        </button>
      )}
      <button type="button" className="btn btn-small file-card-open" onClick={open} disabled={target === "none" || (target === "pane" && !openPath)}>
        <SquareArrowOutUpRight size={13} aria-hidden />
        Open
      </button>
    </div>
  );
}

function ArtifactCard({ card }: { card: Extract<ToolCardData, { type: "artifact" }> }) {
  const actions = useCardActions();
  const url = actions?.daemonBase ? artifactUrl(actions.daemonBase, card.id) : null;
  const open = () => url && actions?.openInBrowser(url);
  const updated = card.updated ? new Date(card.updated * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  return (
    <div className="file-card artifact-card" role="group" aria-label={`Artifact ${card.title}`}>
      <button type="button" className="file-card-main" onClick={open} disabled={!url} title="Open in the Browser pane">
        <span className="file-card-icon artifact" aria-hidden>
          <AppWindow size={18} />
        </span>
        <span className="file-card-text">
          <span className="file-card-name">{card.title || "Artifact"}</span>
          {card.description && <span className="artifact-card-description">{card.description}</span>}
          <span className="file-card-meta">
            Artifact · Version {card.version}
            {updated && ` · ${updated}`}
          </span>
        </span>
      </button>
      {url && actions?.local && (
        <button type="button" className="btn btn-small btn-ghost btn-icon" aria-label="Open in your browser" title="Open in your browser" onClick={() => void openExternal(url)}>
          <ExternalLink size={14} aria-hidden />
        </button>
      )}
      <button type="button" className="btn btn-small file-card-open" onClick={open} disabled={!url}>
        <SquareArrowOutUpRight size={13} aria-hidden />
        Open
      </button>
    </div>
  );
}

/** The host of a URL, for the card ("github.com"). */
export function pageHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(/:$/, "") || url;
  } catch {
    return url;
  }
}

/** The ⋯ menu of a browser card: "Copy URL", "Open minimized", "Open in your browser", "Close tab". */
function BrowserCardMenu({ card }: { card: Extract<ToolCardData, { type: "browser" }> }) {
  const actions = useCardActions();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  // The tab can close after the card shows: check it each time the menu opens.
  const tabOpen = open && !!card.tab && !!actions?.hasTab(card.tab);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card.url);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 700);
    } catch {
      setOpen(false);
    }
  };
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div
      className="browser-card-menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="btn btn-small btn-ghost btn-icon" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions" onClick={() => setOpen((v) => !v)}>
        <Ellipsis size={15} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Page">
          <button type="button" role="menuitem" onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy URL"}
          </button>
          <button type="button" role="menuitem" disabled={!tabOpen || !actions?.minimizeTab} onClick={run(() => card.tab && actions?.minimizeTab?.(card.tab))}>
            <PictureInPicture2 size={14} aria-hidden /> Open minimized
          </button>
          <button type="button" role="menuitem" onClick={run(() => void openExternal(card.url).catch(() => undefined))}>
            <ExternalLink size={14} aria-hidden /> Open in your browser
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" disabled={!tabOpen} onClick={run(() => card.tab && actions?.closeTab(card.tab))}>
            <X size={14} aria-hidden /> Close tab
          </button>
        </div>
      )}
    </div>
  );
}

/** A page that the agent opened: a picture of the page, the title, "{host}, opened in Browser", "Open", and ⋯. */
function BrowserCard({ card }: { card: Extract<ToolCardData, { type: "browser" }> }) {
  const actions = useCardActions();
  const host = pageHost(card.url);
  const title = card.title.trim() || host;
  // "Open" shows the tab of the page in the Browser pane. A closed tab: the page opens in a new tab.
  const open = () => actions?.openTab(card.tab, card.url);
  return (
    <div className="browser-card" role="group" aria-label={`Page ${title}`}>
      {card.image && (
        <button type="button" className="browser-card-shot" onClick={open} disabled={!actions} tabIndex={-1} aria-hidden>
          <img src={card.image} alt="" draggable={false} />
        </button>
      )}
      <div className="browser-card-foot">
        <button type="button" className="file-card-main" onClick={open} disabled={!actions} title="Open in the Browser pane">
          {!card.image && (
            <span className="file-card-icon" aria-hidden>
              <Globe size={18} />
            </span>
          )}
          <span className="file-card-text">
            <span className="file-card-name">{title}</span>
            <span className="file-card-meta">{host}, opened in Browser</span>
          </span>
        </button>
        <button type="button" className="btn btn-small file-card-open" onClick={open} disabled={!actions}>
          Open
        </button>
        <BrowserCardMenu card={card} />
      </div>
    </div>
  );
}

/** The card of a send_file, artifact, or preview_navigate result. */
export const ShareCard = memo(function ShareCard({ card }: { card: ToolCardData }) {
  if (card.type === "artifact") return <ArtifactCard card={card} />;
  if (card.type === "browser") return <BrowserCard card={card} />;
  return (
    <section className="share-files" aria-label={card.files.length === 1 ? "A file from the agent" : `${card.files.length} files from the agent`}>
      {card.caption && <p className="share-caption">{card.caption}</p>}
      {card.files.map((f) => (
        <SentFileRow key={f.abs} file={f} display={card.display} />
      ))}
    </section>
  );
});
