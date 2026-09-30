import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, Folder, LoaderCircle, MessageSquare, Square } from "lucide-react";
import type { CommandItem } from "../daemon/protocol";
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
export type Submission = { kind: "prompt"; text: string; display?: string } | { kind: "command"; name: string; args: string };

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

export function PromptBox({
  running,
  disabled,
  commands,
  onRequestCommands,
  onSubmit,
  onInterrupt,
  insert,
  below,
  sessions = [],
  fileMatches = null,
  onFindFiles,
  onCycleMode,
  suggestion = null,
  onDismissSuggestion,
}: {
  suggestion?: string | null; // The next prompt that the model predicts. The empty box shows it. Tab uses it.
  onDismissSuggestion?: () => void; // The user typed, or pressed Esc.
  onCycleMode?: () => void; // Shift+Tab: the next permission mode.
  sessions?: MentionSession[]; // Other sessions for the "@" menu, newest first.
  fileMatches?: { query: string; items: string[] } | null; // The last fs.found reply.
  onFindFiles?: (query: string) => void; // Asks the daemon for the files that match an "@" query.
  insert?: { text: string; key: number } | null; // Text to add, for example "@src/app.py:10-25" from the editor.
  below?: React.ReactNode; // A row under the box, on the right: the model menu.
  running: boolean;
  disabled: boolean;
  commands: CommandItem[] | null; // null: not loaded yet.
  onRequestCommands: () => void;
  onSubmit: (s: Submission) => boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null); // The start of a closed "/" token.
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null); // The start of a closed "@" token.
  const pendingCaret = useRef<number | null>(null);
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
    if (!disabled) area.current?.focus();
  }, [disabled]);

  useEffect(() => {
    if (!insert) return;
    const next = `${text}${text && !/\s$/.test(text) ? " " : ""}${insert.text} `;
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
    const parsed = parseSubmission(text);
    if (!parsed || disabled) return; // During a turn, the app puts the message in the queue.
    let s = parsed;
    if (s.kind === "prompt") {
      const resolved = resolveSessionRefs(s.text, sessionRefs.current);
      if (resolved !== s.text) s = { kind: "prompt", text: resolved, display: s.text };
    }
    if (onSubmit(s)) {
      change("");
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

  const canSend = !disabled && text.trim().length > 0;
  const mentionOpen = mention !== null && mentionItems.length > 0;
  const activeId = menuOpen && matches.length > 0 ? `slash-opt-${active}` : mentionOpen ? `mention-opt-${mentionActive}` : undefined;
  const firstSession = mentionItems.findIndex((i) => i.kind === "session");

  return (
    <div className="prompt-wrap">
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
      <div className="prompt-box">
        <label htmlFor="prompt-input" className="sr-only">
          Message to the agent
        </label>
        <textarea
          id="prompt-input"
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            running
              ? "Type a message to queue it. Esc interrupts the agent."
              : suggestion
                ? suggestion
                : "Ask the agent. Type / for commands and skills, @ for files."
          }
          onChange={(e) => change(e.target.value, e.target.selectionStart)}
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
            aria-label={running ? "Queue (Enter)" : "Send (Enter)"}
            title={running ? "Queue (Enter): it goes to the agent when the turn ends" : "Send (Enter)"}
          >
            <CornerDownLeft size={16} aria-hidden />
          </button>
        )}
      </div>
      {below && <div className="prompt-below">{below}</div>}
    </div>
  );
}
