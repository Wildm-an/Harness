import { memo, useEffect, useRef } from "react";
import { Check, Clock, FileDiff, ShieldAlert, X } from "lucide-react";
import type { PermissionItem } from "../chat/state";
import type { Decision } from "../daemon/protocol";
import { parseUnifiedDiff } from "../lib/diff";
import { DiffStats } from "./DiffStats";
import { toolSummary } from "./ToolCard";

export const DECIDED: Record<Decision, string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Denied",
};

// The buttons from left to right, as in Claude desktop (docs/UI_RULES.md M8). The keys 1, 2, and 3 select them.
const CHOICES: Decision[] = ["deny", "allow_always", "allow_once"];

/** The choices of a request. A plugin that asks for approval has no rule, so it gets no "Always allow". */
export function permissionChoices(item: PermissionItem): Decision[] {
  return item.rule ? CHOICES : CHOICES.filter((c) => c !== "allow_always");
}

/** The choice for a number key, or null. */
export function choiceForKey(choices: Decision[], key: string): Decision | null {
  const index = ["1", "2", "3"].indexOf(key);
  return index >= 0 && index < choices.length ? choices[index] : null;
}

const TITLE_MAX = 80;

/** The verb and the object of the title "Allow Claude to {action} {object}?", and the full text when the title is short of it. */
function describe(item: PermissionItem): { action: string; prefix?: string; object: string; detail: string | null } {
  const summary = toolSummary(item.tool, item.input);
  if (item.tool === "bash") {
    const first = summary.split("\n")[0];
    const short = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
    return { action: "run", object: short, detail: short === summary ? null : summary };
  }
  if (item.tool === "server") {
    const name = (item.input as { name?: unknown } | null)?.name;
    return { action: "start", prefix: "the server", object: typeof name === "string" ? name : summary, detail: summary };
  }
  if (item.tool === "write" && item.diff && parseUnifiedDiff(item.diff).isNewFile) return { action: "create", object: summary, detail: null };
  if (item.tool === "write") return { action: "overwrite", object: summary, detail: null };
  if (item.tool === "edit") return { action: "edit", object: summary, detail: null };
  return { action: "use", object: item.tool, detail: summary || null };
}

/** "Allow Claude to **{action}** {object}?" (docs/UI_RULES.md M7). */
export function PermissionTitle({ item }: { item: PermissionItem }) {
  const { action, prefix, object } = describe(item);
  return (
    <span className="permission-title">
      Allow Claude to <b>{action}</b> {prefix && `${prefix} `}
      <code>{object}</code>?
    </span>
  );
}

/** Where "Always allow" saves the rule (docs/UI_RULES.md M9). The daemon adds it to .harness/settings.json of the project. */
export function ScopeNote({ rule }: { rule: string | null }) {
  if (!rule) return null;
  return (
    <p className="permission-scope">
      Saves to project settings · <code>{rule}</code>
    </p>
  );
}

/** "Deny", "Always allow", and the primary "Allow once" (docs/UI_RULES.md M8). */
export function PermissionButtons({ item, onDecide }: { item: PermissionItem; onDecide: (decision: Decision) => void }) {
  const number = (d: Decision) => permissionChoices(item).indexOf(d) + 1;
  return (
    <>
      <button type="button" className="btn permission-deny" onClick={() => onDecide("deny")} title={`Deny (Esc or ${number("deny")})`}>
        Deny <kbd>Esc</kbd>
      </button>
      {item.rule && (
        <button
          type="button"
          className="btn"
          onClick={() => onDecide("allow_always")}
          title={`Don't ask again for this tool (Ctrl+Shift+Enter or ${number("allow_always")})`}
        >
          Always allow <kbd>Ctrl+Shift+Enter</kbd>
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => onDecide("allow_once")}
        title={`Allow once (Ctrl+Enter or ${number("allow_once")})`}
      >
        Allow once <kbd>Ctrl+Enter</kbd>
      </button>
    </>
  );
}

/**
 * Ctrl+Enter allows once and Ctrl+Shift+Enter always allows, from any place in the window. The listener runs in
 * the capture phase, so that the prompt box does not also send the text. With two open requests, the older one
 * takes the key. The card and the diff review pane both call this hook: the first listener takes the key.
 */
export function usePermissionShortcuts(item: PermissionItem | null, onDecide: (decision: Decision) => void) {
  const pending = item !== null && item.decision === undefined && !item.expired;
  const always = Boolean(item?.rule);
  const decide = useRef(onDecide);
  decide.current = onDecide;
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.shiftKey && !always) return;
      e.preventDefault();
      e.stopPropagation();
      decide.current(e.shiftKey ? "allow_always" : "allow_once");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, always]);
}

export const PermissionCard = memo(function PermissionCard({
  item,
  reviewing,
  onDecide,
  onReview,
}: {
  item: PermissionItem;
  reviewing: boolean; // The diff review pane shows this request.
  onDecide: (requestId: string, decision: Decision) => void;
  onReview: (requestId: string) => void;
}) {
  const decided = item.decision !== undefined || item.expired === true;
  const options = useRef<HTMLDivElement>(null);

  // A new request gets the keyboard focus, so that 1, 2, 3, or Esc answers it at once. The focus goes to
  // the button row, not to a button: Enter and Space do not answer. The request never takes the focus from a
  // text field, so that a key that the user types for the prompt never answers it.
  useEffect(() => {
    if (decided) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("input, textarea, select, [contenteditable='true']")) return;
    options.current?.focus({ preventScroll: true });
  }, [decided]);

  const decide = (decision: Decision) => {
    onDecide(item.id, decision);
    // The buttons go away. Give the focus back to the prompt.
    document.getElementById("prompt-input")?.focus({ preventScroll: true });
  };
  usePermissionShortcuts(item, decide);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const choice = choiceForKey(permissionChoices(item), e.key);
    if (choice) {
      e.preventDefault();
      decide(choice);
    } else if (e.key === "Escape") {
      e.preventDefault();
      decide("deny");
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const buttons = [...(options.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  const { detail } = describe(item);

  return (
    <section className={`permission-card${decided ? " decided" : ""}`} aria-label="Permission request">
      <header className="permission-head">
        <ShieldAlert size={16} aria-hidden />
        <span id={`perm-q-${item.id}`} className="permission-head-title">
          <PermissionTitle item={item} />
        </span>
        {item.diff && <DiffStats diff={item.diff} />}
        {item.diff && (
          <button
            type="button"
            className={`btn btn-small${reviewing ? " active" : ""}`}
            onClick={() => onReview(item.id)}
            aria-pressed={reviewing}
          >
            <FileDiff size={14} aria-hidden />
            {reviewing ? "In review" : "Review"}
          </button>
        )}
        {item.decision !== undefined && (
          <span className={`permission-outcome ${item.decision === "deny" ? "denied" : "allowed"}`}>
            {item.decision === "deny" ? <X size={14} aria-hidden /> : <Check size={14} aria-hidden />}
            {DECIDED[item.decision]}
          </span>
        )}
        {item.decision === undefined && item.expired && (
          <span className="permission-outcome expired">
            <Clock size={14} aria-hidden />
            No decision
          </span>
        )}
      </header>
      {!decided && (
        <>
          {!item.diff && detail && <pre className="permission-command">{detail}</pre>}
          {item.reason && <p className="permission-reason">{item.reason}</p>}
          <div className="permission-foot">
            <ScopeNote rule={item.rule} />
            <div
              className="permission-actions"
              role="group"
              aria-labelledby={`perm-q-${item.id}`}
              tabIndex={-1}
              ref={options}
              onKeyDown={onKeyDown}
            >
              <PermissionButtons item={item} onDecide={decide} />
            </div>
          </div>
        </>
      )}
    </section>
  );
});
