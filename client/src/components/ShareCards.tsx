// The chat cards of send_file and artifact (daemon tools/share.py), as the file and artifact cards of
// the Claude app. A sent file opens in a pane of the app, or in the default app of the computer. An
// artifact opens in the Browser pane.

import { memo } from "react";
import { AppWindow, ExternalLink, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, FolderOpen, Presentation, SquareArrowOutUpRight } from "lucide-react";
import type { SentFile, ToolCardData } from "../daemon/protocol";
import { useOpenPath } from "../lib/openPath";
import { artifactUrl, fileKind, KIND_LABEL, openTarget, useCardActions, type FileKind } from "../lib/cardActions";
import { openExternal, openLocalPath, revealInExplorer } from "../lib/tauri";
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

/** The card of a send_file or artifact result. */
export const ShareCard = memo(function ShareCard({ card }: { card: ToolCardData }) {
  if (card.type === "artifact") return <ArtifactCard card={card} />;
  return (
    <section className="share-files" aria-label={card.files.length === 1 ? "A file from the agent" : `${card.files.length} files from the agent`}>
      {card.caption && <p className="share-caption">{card.caption}</p>}
      {card.files.map((f) => (
        <SentFileRow key={f.abs} file={f} display={card.display} />
      ))}
    </section>
  );
});
