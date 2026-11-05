import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, Folder, LoaderCircle, MessageSquare, Square, X } from "lucide-react";
import type { CommandItem } from "../daemon/protocol";
import { isAddFilesShortcut } from "../lib/fileRefs";
import { busySend, type BusySend } from "./SettingsDialog";
import { imageFiles, imageToDataUrl, MAX_IMAGES } from "../lib/images";
import { shortTip } from "./Tooltips";
import {
  filterSessions,
  insertMention,
  mentionAt,
  mentionToken,
  resolveSessionRefs,
  sessionLabel,
  type MentionItem,
  type MentionSession,
} from "./mentions";

// "display" is the text that the user sees, if it is not "text": the names of sessions in place of their ids.
// The hint in the box during a turn: what Enter does (Settings > General).
const BUSY_HINTS: Record<BusySend, string> = {
  queue: "Type a message to queue it.",
  interrupt: "Type a message to stop the turn and send it.",
  steer: "Type a message to steer the agent.",
};

// images: the data URLs of pasted images and screenshots.
export type Submission = { kind: "prompt"; text: string; display?: string; images?: string[] } | { kind: "command"; name: string; args: string };

/**
 * A block of context in the prompt box, for example a browser annotation. The box shows it as a
 * small code chip. The agent gets ``text``. The chat shows ``label`` and ``detail``.
 */
export interface PromptAttachment {
  id: string;
  label: string; // For example: "Annotation 1".
  detail: string; // For example: "span.name — Make this row taller."
  text: string; // The full text for the agent. Empty for an image.
  image?: string; // A data URL: a pasted image or a screenshot. The box shows a thumbnail.
}

/** The prompt with its attachments: the text for the agent, and the short text that the chat shows. */
export function withAttachments(s: Submission, attachments: readonly PromptAttachment[]): Submission {
  if (attachments.length === 0) return s;
  const typed = s.kind === "prompt" ? s.text : `/${s.name}${s.args ? ` ${s.args}` : ""}`;
  const shown = s.kind === "prompt" ? (s.display ?? s.text) : typed;
  const blocks = attachments.filter((a) => !a.image);
  const images = attachments.flatMap((a) => (a.image ? [a.image] : []));
  // An image can have a line for the agent too, for example the page of a screenshot.
  const text = [typed, ...attachments.map((a) => a.text.trim())].filter(Boolean).join("\n\n");
  const display = [shown, ...blocks.map((a) => `[${a.label}: ${a.detail}]`)].filter(Boolean).join("\n");
  // The chat shows the images as thumbnails: the display has no text for them.
  return { kind: "prompt", text, ...(display !== text ? { display } : {}), ...(images.length ? { images } : {}) };
}

/** Splits "/name args" into a command. Other text is a prompt. */
export function parseSubmission(raw: string): Submission | null {
  const text = raw.trim();
  if (!text) return null;
  const match = /^\/([A-Za-z0-9_:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match) return { kind: "command", name: match[1], args: (match[2] ?? "").trim() };
  return { kind: "prompt", text };
}

/** The / menu matches: exact name, then name prefix, then name part, then description. */
export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const q = query.toLowerCase();
  const rank = (item: CommandItem): number => {
    const name = item.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    if (q && item.description.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return items
    .map((item, index) => ({ item, index, score: rank(item) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((r) => r.item);
}

/** The "/" token at the caret: its start and the text after "/". null if the caret is not in one.
 * At the start of the prompt, the token is a command. After a space, it names a skill in the prompt. */
export function slashAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** A skill, not a built-in command or a plugin command. Only a skill can go in the middle of a prompt. */
export function isSkill(item: CommandItem): boolean {
  return !item.builtin && item.path !== undefined;
}

/** Replace the "/query" at ``start`` with "/name ". Return the new text and the new caret. */
export function insertCommand(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `/${name}${after.startsWith(" ") ? "" : " "}`;
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

const MAX_HEIGHT_PX = 280;

// The unsent text of each prompt box key (session). It is kept while the app runs.
const drafts = new Map<string, string>();
// The unsent attachments of each prompt box key, as the text.
const draftAttachments = new Map<string, PromptAttachment[]>();
// The inserts and the attachments that a prompt box used (see the "insert" and "attach" props).
const appliedInserts = new WeakSet<object>();

export function saveDraft(key: string, text: string): void {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
}

export function draftOf(key: string): string {
  return drafts.get(key) ?? "";
}

export function PromptBox({
  running,
  disabled,
  commands,
  onRequestCommands,
  onSubmit,
  onInterrupt,
  insert,
  onAddFiles,
  below,
  sessions = [],
  fileMatches = null,
  onFindFiles,
  onCycleMode,
  suggestion = null,
  onDismissSuggestion,
  inputId = "prompt-input",
  label = "Message to the agent",
  placeholder,
  sendEmpty = false,
  busy = false,
  sendBlocked = false,
  sendLabel,
  menuBelow = false,
  boxClassName,
  focusKey,
  draftKey = null,
  attach = null,
}: {
  // The unsent text stays with this key, for example the session id. A change of the key keeps the
  // text for the old key, and shows the text of the new key. null: the text is not kept.
  draftKey?: string | null;
  // A block of context to add, for example a browser annotation. Each new object adds one chip.
  attach?: { item: PromptAttachment; key: number } | null;
  // The start screen uses the same box as a session. These props change it for the start screen.
  inputId?: string;
  label?: string; // The label for a screen reader.
  placeholder?: string; // Replaces the default text of the empty box.
  sendEmpty?: boolean; // Enter with no text sends an empty prompt: the start screen then starts a session with no task.
  busy?: boolean; // The send button shows a spinner and does not send.
  sendBlocked?: boolean; // The send button does not send, but the user can type.
  sendLabel?: { empty: string; text: string }; // The hint of the send button, with no text and with text.
  menuBelow?: boolean; // The / and @ menus open below the box, not above it.
  boxClassName?: string;
  focusKey?: unknown; // A change puts the focus in the box. null: the box does not take the focus.
  suggestion?: string | null; // The next prompt that the model predicts. The empty box shows it. Tab uses it.
  onDismissSuggestion?: () => void; // The user typed, or pressed Esc.
  onCycleMode?: () => void; // Shift+Tab: the next permission mode.
  sessions?: MentionSession[]; // Other sessions for the "@" menu, newest first.
  fileMatches?: { query: string; items: string[] } | null; // The last fs.found reply.
  onFindFiles?: (query: string) => void; // Asks the daemon for the files that match an "@" query.
  // Text to add, for example "@src/app.py:10-25" from the editor. replace: the text replaces the box text (a rewind).
  insert?: { text: string; key: number; replace?: boolean } | null;
  // Ctrl+U, "Add files or photos": the user picks files. The text (references) goes in at the caret. null: nothing.
  onAddFiles?: () => Promise<string | null>;
  below?: React.ReactNode; // A row under the box, on the right: the model menu.
  running: boolean;
  disabled: boolean;
  commands: CommandItem[] | null; // null: not loaded yet.
  onRequestCommands: () => void;
  onSubmit: (s: Submission) => boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState(() => (draftKey !== null ? drafts.get(draftKey) ?? "" : ""));
  // A new key (another session) shows the draft of that session. The draft of the old session stays.
  const [attachments, setAttachments] = useState<PromptAttachment[]>(() => (draftKey !== null ? draftAttachments.get(draftKey) ?? [] : []));
  const [shownKey, setShownKey] = useState(draftKey);
  if (draftKey !== shownKey) {
    setShownKey(draftKey);
    setText(draftKey !== null ? drafts.get(draftKey) ?? "" : "");
    setAttachments(draftKey !== null ? draftAttachments.get(draftKey) ?? [] : []);
  }
  useEffect(() => {
    if (shownKey !== null) saveDraft(shownKey, text);
  }, [text, shownKey]);
  useEffect(() => {
    if (shownKey === null) return;
    if (attachments.length) draftAttachments.set(shownKey, attachments);
    else draftAttachments.delete(shownKey);
  }, [attachments, shownKey]);
  // Each attach object adds one chip, one time (a box that mounts again does not add it again).
  useEffect(() => {
    if (!attach || appliedInserts.has(attach)) return;
    appliedInserts.add(attach);
    setAttachments((list) => [...list, attach.item]);
  }, [attach]);
  /** Add pasted or dropped images as thumbnails. Return true if the data had images. */
  const addImages = (data: DataTransfer | null): boolean => {
    const files = imageFiles(data);
    if (files.length === 0) return false;
    void Promise.all(files.map((file) => imageToDataUrl(file).catch(() => null))).then((urls) => {
      const stamp = Date.now().toString(36);
      setAttachments((list) => {
        const room = MAX_IMAGES - list.filter((a) => a.image).length;
        const added = urls
          .filter((u): u is string => !!u)
          .slice(0, Math.max(0, room))
          .map((url, i) => ({ id: `image-${stamp}-${i}`, label: "Image", detail: "", text: "", image: url }));
        return [...list, ...added];
      });
    });
    return true;
  };
  const removeAttachment = (id: string) => {
    setAttachments((list) => list.filter((a) => a.id !== id));
    area.current?.focus();
  };
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null); // The start of a closed "/" token.
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null); // The start of a closed "@" token.
  const pendingCaret = useRef<number | null>(null);

  // The row under the box (the mode and the model): when their names do not fit side by side, the
  // row shows only their icons. It shows the names again when the width that they need is free.
  const belowRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const neededWidth = useRef(0);
  const checkBelow = useRef(() => {});
  checkBelow.current = () => {
    const row = belowRef.current;
    if (!row) return;
    if (compact) {
      if (row.clientWidth >= neededWidth.current) setCompact(false);
      return;
    }
    const cut = [...row.querySelectorAll<HTMLElement>(".prompt-chip-text")].reduce(
      (sum, el) => sum + Math.max(0, el.scrollWidth - el.clientWidth),
      0,
    );
    // A chip wider than its menu box goes over the next item, for example the context ring.
    const spill = [...row.querySelectorAll<HTMLElement>(".model-menu")].reduce((sum, menu) => {
      const chip = menu.querySelector<HTMLElement>(".prompt-chip");
      return sum + (chip ? Math.max(0, chip.offsetWidth - menu.clientWidth) : 0);
    }, 0);
    const over = Math.max(0, row.scrollWidth - row.clientWidth) + spill;
    if (cut + over > 1) {
      neededWidth.current = row.clientWidth + cut + over;
      setCompact(true);
    }
  };
  useLayoutEffect(() => checkBelow.current()); // The names can change, for example after /model.
  useEffect(() => {
    const row = belowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => checkBelow.current());
    observer.observe(row);
    return () => observer.disconnect();
  }, [below !== undefined]);
  const mentionList = useRef<HTMLUListElement>(null);
  const sessionRefs = useRef(new Map<string, string>()); // The session names in the prompt, and their ids.

  // The "/" menu. At the start of the prompt: the commands and the skills. After a space: the skills only.
  const slash = !disabled ? slashAt(text, caret) : null;
  const token = slash && slash.start !== dismissed ? slash : null;
  const menuOpen = token !== null;
  const inline = token !== null && token.start > 0;
  const matches = useMemo(
    () => (menuOpen && commands ? filterCommands(inline ? commands.filter(isSkill) : commands, token.query) : []),
    [menuOpen, inline, commands, token?.query],
  );

  // Refresh the list each time the menu opens: the user can add a skill at any time.
  useEffect(() => {
    if (menuOpen) onRequestCommands();
  }, [menuOpen]);

  useEffect(() => setActive(0), [token?.query, token?.start]);

  // The "@" menu: the files of the project and the other sessions. The "/" menu has priority.
  const found = !menuOpen && !disabled ? mentionAt(text, caret) : null;
  const mention = found && found.start !== mentionDismissed ? found : null;
  const filesReady = mention !== null && fileMatches?.query === mention.query;
  const mentionItems: MentionItem[] = mention
    ? [
        ...(filesReady ? fileMatches.items.map((path): MentionItem => ({ kind: "file", path })) : []),
        ...filterSessions(sessions, mention.query).map((session): MentionItem => ({ kind: "session", session })),
      ]
    : [];

  useEffect(() => {
    if (mention && onFindFiles) onFindFiles(mention.query);
    setMentionActive(0);
  }, [mention?.query, mention !== null]);

  useEffect(() => {
    mentionList.current?.querySelector<HTMLElement>(`[data-index="${mentionActive}"]`)?.scrollIntoView({ block: "nearest" });
  }, [mentionActive]);

  // Put the caret after a reference that the menu added.
  useEffect(() => {
    if (pendingCaret.current === null || !area.current) return;
    area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Grow the text box with its content, up to a limit. Measure again when the width changes.
  // An empty box keeps the CSS height: the browser includes the placeholder in scrollHeight.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "";
      if (el.value) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (!disabled && focusKey !== null) area.current?.focus();
  }, [disabled, focusKey]);

  useEffect(() => {
    // Each insert goes in one time. A box that mounts again (another session, or another view)
    // does not add the old text again.
    if (!insert || appliedInserts.has(insert)) return;
    appliedInserts.add(insert);
    const next = insert.replace ? insert.text : `${text}${text && !/\s$/.test(text) ? " " : ""}${insert.text} `;
    pendingCaret.current = next.length;
    change(next);
    area.current?.focus();
  }, [insert]);

  const change = (value: string, at?: number) => {
    if (value && suggestion) onDismissSuggestion?.();
    setText(value);
    setCaret(at ?? value.length);
    if (dismissed !== null && value[dismissed] !== "/") setDismissed(null);
    if (mentionDismissed !== null && value[mentionDismissed] !== "@") setMentionDismissed(null);
  };

  /** Replace the "@query" with the reference of the item. */
  const chooseMention = (item: MentionItem) => {
    if (!mention) return;
    if (item.kind === "session") sessionRefs.current.set(sessionLabel(item.session), item.session.id);
    const next = insertMention(text, caret, mention.start, mentionToken(item));
    pendingCaret.current = next.caret;
    change(next.text, next.caret);
    area.current?.focus();
  };

  const submit = () => {
    // A prompt with only attachments (for example browser annotations) can go too.
    const parsed = parseSubmission(text) ?? (sendEmpty || attachments.length ? { kind: "prompt" as const, text: "" } : null);
    if (!parsed || disabled || busy || sendBlocked) return; // During a turn, the app puts the message in the queue.
    let s: Submission = parsed;
    if (s.kind === "prompt") {
      const resolved = resolveSessionRefs(s.text, sessionRefs.current);
      if (resolved !== s.text) s = { kind: "prompt", text: resolved, display: s.text };
    }
    s = withAttachments(s, attachments);
    if (onSubmit(s)) {
      change("");
      setAttachments([]);
      sessionRefs.current.clear();
    }
  };

  /** Put the command in the box. A command with no arguments runs at once if ``run`` is set and the
   * command is the only text. A skill in the middle of a prompt goes to the agent with the prompt. */
  const choose = (item: CommandItem, run: boolean) => {
    if (!token) return;
    if (run && !inline && !item["argument-hint"] && !text.slice(caret).trim()) {
      if (onSubmit({ kind: "command", name: item.name, args: "" })) change("");
      return;
    }
    const next = insertCommand(text, caret, token.start, item.name);
    pendingCaret.current = next.caret;
    change(next.text, next.caret);
    area.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Backspace at the start of the box removes the last chip, as in the Claude app.
    if (e.key === "Backspace" && attachments.length && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      setAttachments((list) => list.slice(0, -1));
      return;
    }
    if (onAddFiles && isAddFilesShortcut(e.nativeEvent)) {
      e.preventDefault();
      const at = area.current?.selectionStart ?? text.length;
      void onAddFiles().then((refs) => {
        if (!refs) return;
        const before = text.slice(0, at);
        const after = text.slice(at);
        const added = `${before && !/\s$/.test(before) ? " " : ""}${refs}${after.startsWith(" ") ? "" : " "}`;
        pendingCaret.current = before.length + added.length;
        change(before + added + after);
        area.current?.focus();
      });
      return;
    }
    if (mention && mentionItems.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionActive((i) => (i + step + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        chooseMention(mentionItems[Math.min(mentionActive, mentionItems.length - 1)]);
        return;
      }
    }
    if (mention && e.key === "Escape") {
      e.preventDefault();
      setMentionDismissed(mention.start);
      return;
    }
    if (menuOpen && matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        choose(matches[Math.min(active, matches.length - 1)], e.key === "Enter");
        return;
      }
    }
    // The suggestion: Tab puts it in the empty box. Enter then sends it. Esc hides it.
    if (!text && suggestion && !running) {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        pendingCaret.current = suggestion.length;
        change(suggestion);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDismissSuggestion?.();
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey && onCycleMode) {
      e.preventDefault();
      onCycleMode();
      return;
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissed(token.start);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      onInterrupt();
    }
  };

  const canSend = !disabled && !busy && !sendBlocked && (sendEmpty || text.trim().length > 0 || attachments.length > 0);
  const mentionOpen = mention !== null && mentionItems.length > 0;
  const sendHint = sendLabel ? (text.trim() ? sendLabel.text : sendLabel.empty) : running ? "Queue (Enter)" : "Send (Enter)";
  const activeId = menuOpen && matches.length > 0 ? `slash-opt-${active}` : mentionOpen ? `mention-opt-${mentionActive}` : undefined;
  const firstSession = mentionItems.findIndex((i) => i.kind === "session");

  return (
    <div className={`prompt-wrap${menuBelow ? " menu-below" : ""}`}>
      {/* The menus open above the box, or below it. The row under the box is not in the anchor. */}
      <div className="prompt-anchor">
        {menuOpen && (
          <div className="slash-menu">
            {commands === null ? (
              <p className="slash-empty">Loading the commands.</p>
            ) : matches.length === 0 ? (
              <p className="slash-empty">{inline ? `No skill matches /${token.query}.` : `No command or skill matches /${token.query}.`}</p>
            ) : (
              <ul id="slash-menu" role="listbox" aria-label={inline ? "Skills" : "Commands and skills"} ref={list}>
                {matches.map((item, i) => (
                  <li
                    key={`${item.builtin ? "b" : "s"}-${item.name}`}
                    id={`slash-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "active" : undefined}
                    onMouseDown={(e) => e.preventDefault()} // Keep the focus in the text box.
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(item, true)}
                  >
                    <span className="slash-name mono">/{item.name}</span>
                    {item["argument-hint"] && <span className="slash-hint mono">{item["argument-hint"]}</span>}
                    <span className={`slash-source${item.builtin ? " builtin" : ""}`}>{item.builtin ? "command" : item.source}</span>
                    <span className="slash-desc">{item.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="slash-foot">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> select
              </span>
              <span>
                <kbd>Tab</kbd> complete
              </span>
              <span>
                <kbd>Enter</kbd> {inline ? "add" : "run"}
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </div>
          </div>
        )}
        {mention && (
          <div className="slash-menu mention-menu">
            {mentionItems.length === 0 ? (
              <p className="slash-empty">
                {filesReady ? (
                  `No file, folder, or session matches @${mention.query}.`
                ) : (
                  <>
                    <LoaderCircle size={13} className="spin" aria-hidden /> Looking for files.
                  </>
                )}
              </p>
            ) : (
              <ul id="mention-menu" role="listbox" aria-label="Files and sessions" ref={mentionList}>
                {mentionItems.map((item, i) => (
                  <li
                    key={item.kind === "file" ? `f-${item.path}` : `s-${item.session.id}`}
                    id={`mention-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === mentionActive}
                    className={`${i === mentionActive ? "active" : ""}${i === firstSession && i > 0 ? " mention-first-session" : ""}`}
                    onMouseDown={(e) => e.preventDefault()} // Keep the focus in the text box.
                    onMouseEnter={() => setMentionActive(i)}
                    onClick={() => chooseMention(item)}
                  >
                    {item.kind === "file" ? (
                      <>
                        {item.path.endsWith("/") ? <Folder size={14} aria-hidden /> : <FileText size={14} aria-hidden />}
                        <span className="slash-name mono">{item.path}</span>
                      </>
                    ) : (
                      <>
                        <MessageSquare size={14} aria-hidden />
                        <span className="mention-title">{item.session.title ?? "Untitled session"}</span>
                        <span className="slash-source">session</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="slash-foot">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> select
              </span>
              <span>
                <kbd>Enter</kbd> add
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
            </div>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {menuOpen && commands ? `${matches.length} ${inline ? "skills" : "commands"} match.` : mentionOpen ? `${mentionItems.length} files and sessions match.` : ""}
        </span>
        <div className={`prompt-box${boxClassName ? ` ${boxClassName}` : ""}`}>
          <label htmlFor={inputId} className="sr-only">
            {label}
          </label>
          {attachments.length > 0 && (
            <ul className="prompt-attachments" aria-label="Attached context">
              {attachments.map((a) => (
                <li key={a.id} className={`prompt-attachment${a.image ? " image" : ""}`} title={a.image ? a.label : shortTip(a.text)}>
                  {a.image ? (
                    <img src={a.image} alt={a.label} className="prompt-attachment-thumb" />
                  ) : (
                    <code>
                      <span className="prompt-attachment-label">{a.label}</span> {a.detail}
                    </code>
                  )}
                  <button
                    type="button"
                    className="prompt-attachment-remove"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.label}`}
                    title="Remove (Backspace at the start of the box)"
                  >
                    <X size={10} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            id={inputId}
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={
              running
                ? `${BUSY_HINTS[busySend()]} Esc interrupts the agent.`
                : suggestion
                  ? suggestion
                  : (placeholder ?? "Type / for commands and skills, @ for files.")
            }
            onChange={(e) => change(e.target.value, e.target.selectionStart)}
            // A pasted screenshot or a dropped image becomes a thumbnail. Pasted text stays text.
            onPaste={(e) => {
              const hasText = !!e.clipboardData.getData("text/plain");
              if (addImages(e.clipboardData) && !hasText) e.preventDefault();
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file" && i.type.startsWith("image/"))) e.preventDefault();
            }}
            onDrop={(e) => {
              if (addImages(e.dataTransfer)) e.preventDefault();
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={(menuOpen && matches.length > 0) || mentionOpen}
            aria-controls={menuOpen && matches.length > 0 ? "slash-menu" : mentionOpen ? "mention-menu" : undefined}
            aria-activedescendant={activeId}
          />
          {!text && suggestion && !running && (
            <span className="suggestion-hint" aria-hidden>
              <kbd>Tab</kbd>
            </span>
          )}
          {/* In line with the text. When the text grows, the button stays at the bottom right. */}
          {running && !canSend ? (
            <button type="button" className="icon-btn stop" onClick={onInterrupt} aria-label="Interrupt (Esc)" title="Interrupt (Esc)">
              <Square size={12} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn send"
              onClick={submit}
              disabled={!canSend}
              aria-label={sendHint}
              title={sendLabel || !running ? sendHint : "Queue (Enter): it goes to the agent when the turn ends"}
            >
              {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <CornerDownLeft size={16} aria-hidden />}
            </button>
          )}
      </div>
      </div>
      {below && (
        <div className={`prompt-below${compact ? " compact" : ""}`} ref={belowRef}>
          {below}
        </div>
      )}
    </div>
  );
}
