import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { CommandItem } from "../daemon/protocol";

export type Submission = { kind: "prompt"; text: string } | { kind: "command"; name: string; args: string };

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

// The menu is open while the user types the command name: "/" and no space yet.
const COMMAND_TOKEN = /^\/([^\s]*)$/;
const MAX_HEIGHT_PX = 280;

export function PromptBox({
  running,
  disabled,
  commands,
  onRequestCommands,
  onSubmit,
  onInterrupt,
  insert,
}: {
  insert?: { text: string; key: number } | null; // Text to add, for example "@src/app.py:10-25" from the editor.
  running: boolean;
  disabled: boolean;
  commands: CommandItem[] | null; // null: not loaded yet.
  onRequestCommands: () => void;
  onSubmit: (s: Submission) => boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const token = COMMAND_TOKEN.exec(text);
  const menuOpen = token !== null && !dismissed && !disabled;
  const matches = useMemo(
    () => (menuOpen && commands ? filterCommands(commands, token[1]) : []),
    [menuOpen, commands, token?.[1]],
  );

  // Refresh the list each time the menu opens: the user can add a skill at any time.
  useEffect(() => {
    if (menuOpen) onRequestCommands();
  }, [menuOpen]);

  useEffect(() => setActive(0), [token?.[1]]);

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
    setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}${insert.text} `);
    area.current?.focus();
  }, [insert]);

  const change = (value: string) => {
    setText(value);
    if (!value.startsWith("/")) setDismissed(false);
  };

  const submit = () => {
    const s = parseSubmission(text);
    if (!s || running || disabled) return;
    if (onSubmit(s)) change("");
  };

  /** Put the command in the box. A command with no arguments runs at once if ``run`` is set. */
  const choose = (item: CommandItem, run: boolean) => {
    if (run && !item["argument-hint"] && !running) {
      if (onSubmit({ kind: "command", name: item.name, args: "" })) change("");
      return;
    }
    change(`/${item.name} `);
    area.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
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

  const canSend = !running && !disabled && text.trim().length > 0;
  const activeId = menuOpen && matches.length > 0 ? `slash-opt-${active}` : undefined;

  return (
    <div className="prompt-wrap">
      {menuOpen && (
        <div className="slash-menu">
          {commands === null ? (
            <p className="slash-empty">Loading the commands.</p>
          ) : matches.length === 0 ? (
            <p className="slash-empty">No command or skill matches /{token[1]}.</p>
          ) : (
            <ul id="slash-menu" role="listbox" aria-label="Commands and skills" ref={list}>
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
              <kbd>Enter</kbd> run
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {menuOpen && commands ? `${matches.length} commands match.` : ""}
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
          placeholder={running ? "The agent is working. Press Esc to interrupt." : "Ask the agent. Type / for commands and skills."}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={menuOpen && matches.length > 0}
          aria-controls={menuOpen && matches.length > 0 ? "slash-menu" : undefined}
          aria-activedescendant={activeId}
        />
        {running ? (
          <button type="button" className="icon-btn stop" onClick={onInterrupt} aria-label="Interrupt (Esc)" title="Interrupt (Esc)">
            <Square size={14} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn send"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send (Enter)"
            title="Send (Enter)"
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
