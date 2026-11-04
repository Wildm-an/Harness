// A card in the chat for a new PDF or Word file that a tool call made (daemon created.py), as the
// file cards of the Claude app. "Open" (or a click on the card) opens the file in the Preview pane.

import { memo } from "react";
import { FileText, SquareArrowOutUpRight } from "lucide-react";
import { previewKind } from "../preview/document";
import { useOpenPath } from "../lib/openPath";

const TYPE_LABEL = { pdf: "PDF document", docx: "Word document" } as const;

/** The file name, and the folder of a project path ("" for a file at the top of the project). */
export function splitPath(path: string): { name: string; folder: string } {
  const clean = path.replace(/\\/g, "/");
  const at = clean.lastIndexOf("/");
  return at < 0 ? { name: clean, folder: "" } : { name: clean.slice(at + 1), folder: clean.slice(0, at) };
}

export const FileCard = memo(function FileCard({ path }: { path: string }) {
  const openPath = useOpenPath();
  const kind = previewKind(path);
  const { name, folder } = splitPath(path);
  const open = () => openPath?.(path);
  return (
    <div className="file-card" role="group" aria-label={`New file ${name}`}>
      <button type="button" className="file-card-main" onClick={open} disabled={!openPath} title={`Open ${path} in the Preview pane`}>
        <span className={`file-card-icon${kind ? ` ${kind}` : ""}`} aria-hidden>
          <FileText size={18} />
        </span>
        <span className="file-card-text">
          <span className="file-card-name">{name}</span>
          <span className="file-card-meta">
            {kind ? TYPE_LABEL[kind] : "File"}
            {folder && <span className="file-card-folder"> · {folder}</span>}
          </span>
        </span>
      </button>
      <button type="button" className="btn btn-small file-card-open" onClick={open} disabled={!openPath}>
        <SquareArrowOutUpRight size={13} aria-hidden />
        Open
      </button>
    </div>
  );
});
