// The title of the session in the top bar (UI_RULES V5). A click on the title renames the session in
// place. The caret button at its right opens the session menu: the same menu as a sidebar row.

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { PullRequest, SessionSummary } from "../daemon/protocol";
import { SessionMenu, splitItem, type MenuAction, type SessionActions } from "./SessionRow";

export function SessionTitle({ id, title, summary, unread, pr, actions }: {
  id: string;
  title: string;
  summary: Pick<SessionSummary, "pinned" | "archived"> | undefined; // The sidebar row of the session.
  unread: boolean;
  pr: PullRequest | null; // The pull request of the branch of the session.
  actions: SessionActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);

  const finishRename = (value: string | null) => {
    setRenaming(false);
    const next = value?.trim();
    if (next && next !== title) actions.onRename(id, next);
  };

  const act = (action: MenuAction) => {
    setMenu(false);
    if (action === "pin") actions.onPin(id, !summary?.pinned);
    else if (action === "unread") actions.onMarkUnread(id, !unread);
    else if (action === "rename") setRenaming(true);
    else if (action === "archive") actions.onArchive(id, !summary?.archived);
    else if (action === "split") actions.onOpenSplit?.(id);
    else if (action === "pr") pr?.url && actions.onOpenPr?.(pr.url);
    else actions.onDelete(id);
  };

  return (
    <span className="topbar-session" data-tauri-drag-region="false">
      {renaming ? (
        <input
          className="topbar-rename"
          aria-label="The name of the session"
          defaultValue={title}
          autoFocus
          size={Math.max(12, title.length + 2)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename(e.currentTarget.value);
            else if (e.key === "Escape") finishRename(null);
          }}
          onBlur={(e) => finishRename(e.currentTarget.value)}
        />
      ) : (
        <button type="button" className="topbar-name" title="Rename" onClick={() => setRenaming(true)}>
          {title}
        </button>
      )}
      <button
        ref={caret}
        type="button"
        className={`icon-btn ghost topbar-caret${menu ? " active" : ""}`}
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        title="More actions"
        onClick={() => setMenu((v) => !v)}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {menu && caret.current && (
        <SessionMenu
          session={{ title, pinned: summary?.pinned, archived: summary?.archived }}
          unread={unread}
          prItem={!!pr?.url && !!actions.onOpenPr}
          split={splitItem(actions, true)}
          anchor={caret.current}
          at={null}
          align="left"
          onAction={act}
          onClose={() => setMenu(false)}
        />
      )}
    </span>
  );
}
