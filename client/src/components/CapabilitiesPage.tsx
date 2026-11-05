// The Capabilities page: the skills, the MCP servers, and the plugins on tabs, as the "Customize" page
// of the Claude app and the Skills and MCP pages of the Hermes dashboard show them. The "Capabilities"
// item in the sidebar opens it. Each row shows the name, a short description, and the status. A skill
// row opens the skill. An MCP row opens its tools, its target, and its error.

import { memo, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  FileCog,
  FileText,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  Package,
  Plug,
  RefreshCw,
  Search,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { SlashIcon } from "./SlashIcon";
import { Markdown } from "./Markdown";
import { openExternal } from "../lib/tauri";
import { ConnectorLogo, hasConnectorLogo } from "./ConnectorLogo";
import type { CommandItem, ConnectorItem, ConnectorOptions, GoogleConnectOptions, McpServerItem, McpState, McpStatus, PluginsStatus, SkillDetail } from "../daemon/protocol";

export type CapabilityStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disabled"
  | "stopped"
  | "needs_auth"
  | "authenticating"
  | "linked"
  | "unlinked"
  | "enabled"
  | "command"
  | "model";

const STATUS: Record<CapabilityStatus, { label: string; tone: "ok" | "busy" | "bad" | "off" | "warn"; icon: LucideIcon; tip: string }> = {
  connected: { label: "Connected", tone: "ok", icon: CircleCheck, tip: "The server is connected. The agent can use its tools." },
  connecting: { label: "Connecting", tone: "busy", icon: LoaderCircle, tip: "The server starts." },
  failed: { label: "Failed", tone: "bad", icon: CircleX, tip: "The server did not start. Open the row to see the error." },
  disabled: { label: "Disabled", tone: "off", icon: CircleSlash, tip: "The configuration turns off this server." },
  stopped: { label: "Not connected", tone: "off", icon: Plug, tip: "The server connects when a session starts in this folder." },
  needs_auth: { label: "Needs authentication", tone: "warn", icon: KeyRound, tip: "The server needs a sign-in. Click Authenticate." },
  authenticating: { label: "Authenticating", tone: "busy", icon: LoaderCircle, tip: "Sign in on the page that opened in your browser." },
  linked: { label: "Connected", tone: "ok", icon: CircleCheck, tip: "Harness has a token. The MCP server is in your mcp.json." },
  unlinked: { label: "Not connected", tone: "off", icon: Plug, tip: "Connect it to add its MCP server for all your projects." },
  enabled: { label: "Enabled", tone: "ok", icon: CircleCheck, tip: "You can run it as a / command. The agent can also use it." },
  command: { label: "Command only", tone: "off", icon: CircleSlash, tip: "Only you can run it, as a / command. The agent does not use it." },
  model: { label: "Agent only", tone: "ok", icon: CircleCheck, tip: "Only the agent uses it. It is not a / command." },
};

const MCP_STATUS: Record<McpState, CapabilityStatus> = {
  starting: "connecting",
  connected: "connected",
  failed: "failed",
  disabled: "disabled",
  stopped: "stopped",
  needs_auth: "needs_auth",
  authenticating: "authenticating",
};

/** The status of a skill, from its frontmatter. */
export function skillStatus(item: CommandItem): CapabilityStatus {
  const user = item["user-invocable"] !== false;
  const model = item["model-invocable"] !== false;
  if (user && model) return "enabled";
  if (user) return "command";
  if (model) return "model";
  return "disabled";
}

/** The short description of an MCP server: the tool count, the transport, and the scope. */
export function mcpSummary(item: McpServerItem): string {
  const parts: string[] = [];
  if (item.state === "connected") parts.push(item.tools.length === 1 ? "1 tool" : `${item.tools.length} tools`);
  parts.push(item.transport, item.scope);
  return parts.join(" · ");
}

const CAP_TABS: [CapTab, string][] = [
  ["skills", "Skills"],
  ["connections", "Connectors"],
  ["plugins", "Plugins"],
  ["mcp", "MCP servers"],
];

/** True when each word of the filter is in one of the fields. Case does not matter. */
export function matches(query: string, ...fields: string[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: "", body: text };
}

function StatusPill({ status }: { status: CapabilityStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={`cap-status cap-${s.tone}`} title={s.tip}>
      <Icon size={13} aria-hidden className={status === "connecting" || status === "authenticating" ? "spin" : undefined} />
      {s.label}
    </span>
  );
}

function Badges({ item }: { item: CommandItem }) {
  return (
    <span className="skill-badges">
      {item["user-invocable"] !== false && <span className="badge">/ command</span>}
      {item["model-invocable"] !== false && <span className="badge">model</span>}
      {item.context === "fork" && <span className="badge">subagent</span>}
    </span>
  );
}

function SkillView({ detail, onBack }: { detail: SkillDetail; onBack: () => void }) {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(detail.content), [detail.content]);
  return (
    <div className="skill-view">
      <button type="button" className="btn btn-small" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden />
        All capabilities
      </button>
      <div className="cap-view-head">
        <h2 className="mono">/{detail.name}</h2>
        <StatusPill status={skillStatus(detail)} />
      </div>
      <p className="help">{detail.description}</p>
      <dl className="skill-meta">
        <dt>Source</dt>
        <dd>{detail.source}</dd>
        <dt>File</dt>
        <dd className="mono">{detail.path}</dd>
        <dt>Use</dt>
        <dd>
          <Badges item={detail} />
        </dd>
        {detail["argument-hint"] && (
          <>
            <dt>Arguments</dt>
            <dd className="mono">{detail["argument-hint"]}</dd>
          </>
        )}
        {detail["allowed-tools"].length > 0 && (
          <>
            <dt>Allowed tools</dt>
            <dd className="mono">{detail["allowed-tools"].join(", ")}</dd>
          </>
        )}
      </dl>
      {detail.files.length > 1 && (
        <details className="skill-files">
          <summary>{detail.files.length} files in the folder</summary>
          <ul>
            {detail.files.map((f) => (
              <li key={f} className="mono">
                <FileText size={12} aria-hidden /> {f}
              </li>
            ))}
          </ul>
        </details>
      )}
      {frontmatter && (
        <details className="skill-files">
          <summary>Frontmatter</summary>
          <pre className="tool-pre">{frontmatter}</pre>
        </details>
      )}
      <div className="skill-body">
        <Markdown text={body} />
      </div>
    </div>
  );
}

/** The two lists of the Skills tab: the skills that come with Harness, and the skills that the user added. */
export type SkillGroup = "builtin" | "added";

const SKILL_GROUPS: { id: SkillGroup; title: string; desc: string; icon: LucideIcon }[] = [
  { id: "builtin", title: "Built-in skills", desc: "Skills that come with Harness: documents, code review, debugging, and skill and MCP server tools.", icon: Package },
  { id: "added", title: "Added skills", desc: "Skills from your skill folders, the project, and the plugins.", icon: FolderPlus },
];

/** The skills of a group. A built-in skill has "bundled": true. */
export function skillsOfGroup(items: CommandItem[], group: SkillGroup): CommandItem[] {
  return items.filter((i) => (group === "builtin") === (i.bundled === true));
}

function SkillGroupRow({ title, desc, icon: Icon, count, onOpen }: { title: string; desc: string; icon: LucideIcon; count: number | null; onOpen: () => void }) {
  return (
    <li className="cap-item">
      <button type="button" className="cap-row" onClick={onOpen}>
        <span className="cap-icon" aria-hidden>
          <Icon size={15} />
        </span>
        <span className="cap-text">
          <span className="cap-name">{title}</span>
          <span className="cap-desc">{desc}</span>
        </span>
        {count !== null && <span className="cap-count">{count}</span>}
        <ChevronRight size={14} aria-hidden className="cap-go" />
      </button>
    </li>
  );
}

function SectionHead({ id, title, count, children }: { id: string; title: string; count?: string; children?: React.ReactNode }) {
  return (
    <div className="cap-section-head">
      <h2 id={id}>{title}</h2>
      {count && <span className="cap-count">{count}</span>}
      <span className="cap-section-actions">{children}</span>
    </div>
  );
}

function SkillRow({ item, onOpen }: { item: CommandItem; onOpen: () => void }) {
  return (
    <li className="cap-item">
      <button type="button" className="cap-row" onClick={onOpen}>
        <span className="cap-icon" aria-hidden>
          <SlashIcon size={15} />
        </span>
        <span className="cap-text">
          <span className="cap-name mono">/{item.name}</span>
          <span className="cap-desc">{item.description || item.source}</span>
        </span>
        <span className="cap-source">{item.source}</span>
        <StatusPill status={skillStatus(item)} />
        <ChevronRight size={14} aria-hidden className="cap-go" />
      </button>
    </li>
  );
}

/** An OAuth action of an MCP server row. "code": the URL that the user pasted from the browser. */
export type McpAuthAction =
  | { kind: "auth" | "cancel" | "logout"; name: string }
  | { kind: "code"; name: string; url: string };

/** The sign-in of an OAuth server: the page in the browser, and the paste field for a browser on another computer. */
function McpSignIn({ item, onAuth }: { item: McpServerItem; onAuth: (action: McpAuthAction) => void }) {
  const [pasted, setPasted] = useState("");
  const url = item.auth_url;
  const submit = () => {
    const text = pasted.trim();
    if (!text) return;
    onAuth({ kind: "code", name: item.name, url: text });
    setPasted("");
  };
  return (
    <div className="mcp-signin">
      <p className="help">Sign in on the page that opened in your browser. Harness connects when the sign-in completes.</p>
      <div className="mcp-signin-actions">
        {url && /^https?:\/\//.test(url) && (
          <button type="button" className="btn btn-small" onClick={() => void openExternal(url)}>
            Open sign-in page
          </button>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={() => onAuth({ kind: "cancel", name: item.name })}>
          Cancel
        </button>
      </div>
      <p className="help">If the browser shows an error page after the sign-in, copy the URL from its address bar and paste it here.</p>
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="mono"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="http://127.0.0.1:…/callback?code=…"
          aria-label={`Callback URL for ${item.name}`}
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={!pasted.trim()}>
          Submit
        </button>
      </form>
    </div>
  );
}

function McpRow({
  item,
  live,
  busy,
  onRestart,
  onAuth,
  onOpenConnectors,
}: {
  item: McpServerItem;
  live: boolean;
  busy: boolean;
  onRestart: () => void;
  onAuth: (action: McpAuthAction) => void;
  onOpenConnectors: () => void;
}) {
  // A failed server opens at once, so the error shows. A sign-in opens the row too.
  const [open, setOpen] = useState(item.state === "failed" || item.state === "authenticating");
  useEffect(() => {
    if (item.state === "authenticating") setOpen(true);
  }, [item.state]);
  const status = MCP_STATUS[item.state];
  return (
    <li className={`cap-item${open ? " open" : ""}`}>
      <div className="cap-row-wrap">
        <button type="button" className="cap-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`cap-icon${status === "failed" ? " bad" : hasConnectorLogo(item.connector) ? " cap-logo" : ""}`} aria-hidden>
            {item.connector ? <ConnectorLogo id={item.connector} size={16} /> : <Plug size={15} />}
          </span>
          <span className="cap-text">
            <span className="cap-name">{item.name}</span>
            <span className="cap-desc">{item.error && !open ? item.error : mcpSummary(item)}</span>
          </span>
          <StatusPill status={status} />
          <ChevronRight size={14} aria-hidden className="cap-chevron" />
        </button>
        {live && item.state === "needs_auth" && item.connector && (
          <button type="button" className="btn btn-small btn-primary cap-auth" onClick={onOpenConnectors}>
            Connect
          </button>
        )}
        {live && item.state === "needs_auth" && !item.connector && (
          <button type="button" className="btn btn-small btn-primary cap-auth" onClick={() => onAuth({ kind: "auth", name: item.name })}>
            Authenticate
          </button>
        )}
        {live && (
          <button
            type="button"
            className="icon-btn ghost cap-restart"
            onClick={onRestart}
            disabled={busy}
            aria-label={`Restart ${item.name}`}
            title="Restart: read the configuration again and connect again"
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div className="cap-more">
          <p className="mcp-target mono" title={item.target}>
            {item.target}
          </p>
          {item.error && (
            <div className="notice-bar bad" role="alert">
              <CircleX size={15} aria-hidden />
              <span>{item.error}</span>
            </div>
          )}
          {item.log && item.log.length > 0 && <pre className="server-log mcp-log">{item.log.join("\n")}</pre>}
          {live && item.state === "authenticating" && <McpSignIn item={item} onAuth={onAuth} />}
          {live && item.signed_in && item.state !== "authenticating" && (
            <div className="mcp-signin-actions">
              <button type="button" className="btn btn-small" onClick={() => onAuth({ kind: "auth", name: item.name })}>
                Re-authenticate
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => onAuth({ kind: "logout", name: item.name })}>
                Clear authentication
              </button>
            </div>
          )}
          {item.tools.length > 0 ? (
            <ul className="mcp-tools">
              {item.tools.map((t) => (
                <li key={t.name}>
                  <span className="mono mcp-tool-name">{t.agent_name || t.name}</span>
                  {t.description && <span className="help">{t.description}</span>}
                </li>
              ))}
            </ul>
          ) : (
            !live && <p className="help">The tools show when a session connects to the server.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** An action of a connector row. */
export type ConnectorAction =
  | { kind: "connect"; id: string; source: "gh" }
  | { kind: "connect"; id: string; source: "token"; token: string }
  | { kind: "connect"; id: string; source: "device"; options: ConnectorOptions }
  | { kind: "connect"; id: string; source: "google"; options: GoogleConnectOptions }
  | { kind: "connect"; id: string; source: "local"; profile: "own" | "separate" }
  | { kind: "auth_code"; id: string; url: string }
  | { kind: "cancel"; id: string }
  | { kind: "remove_account"; id: string; login: string }
  | { kind: "disconnect"; id: string };

/** The device code of a sign-in that waits for the user (daemon message "connectors.device_code"). */
export interface DeviceCode {
  id: string;
  url: string;
  code: string;
}

const ACCOUNT_NAMES: Record<ConnectorOptions["account"], string> = {
  personal: "Personal account",
  work: "Work or school account",
};

/** The name of an account type. Gmail accounts are "Google account". */
function accountName(type: ConnectorOptions["account"] | "google"): string {
  return type === "google" ? "Google account" : ACCOUNT_NAMES[type];
}

const CHROME_PROFILES: Record<"own" | "separate", string> = {
  own: "Your Chrome window",
  separate: "A separate Chrome profile",
};

/** The short description of a connector: the account and the token source, or what it gives. */
export function connectorSummary(item: ConnectorItem): string {
  if (!item.source) return item.description;
  if (item.source === "local") return item.profile ? CHROME_PROFILES[item.profile] : "Connected";
  if (item.source === "device" || item.source === "google") {
    const accounts = item.accounts ?? [];
    if (accounts.length > 1) return `${accounts.length} accounts · ${accounts.map((a) => a.login).join(", ")}`;
    const [first] = accounts;
    if (!first) return item.login ?? "Connected";
    return [first.login, accountName(first.type), ...(first.read_only ? ["read-only"] : [])].join(" · ");
  }
  const source = item.source === "gh" ? "GitHub CLI" : "personal access token";
  return `${item.login ? `@${item.login}` : "Connected"} · ${source}`;
}

/** The sign-in of a "token" connector (GitHub): the GitHub CLI, or a pasted token. */
function TokenConnect({ item, busy, onAction }: { item: ConnectorItem; busy: boolean; onAction: (action: ConnectorAction) => void }) {
  const [token, setToken] = useState("");
  const submit = () => {
    const text = token.trim();
    if (!text) return;
    onAction({ kind: "connect", id: item.id, source: "token", token: text });
    setToken("");
  };
  return (
    <div className="mcp-signin">
      {item.gh_available ? (
        <div className="mcp-signin-actions">
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => onAction({ kind: "connect", id: item.id, source: "gh" })}>
            Use GitHub CLI
          </button>
          <span className="help">The token of "gh auth login" on the daemon computer.</span>
        </div>
      ) : (
        <p className="help">
          To use the GitHub CLI, run <code>gh auth login</code> on the daemon computer. Or paste a token here.
        </p>
      )}
      {item.token_help && <p className="help">{item.token_help}</p>}
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="password"
          className="mono"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="github_pat_…"
          aria-label={`Personal access token for ${item.name}`}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={busy || !token.trim()}>
          Connect
        </button>
      </form>
      {item.token_url && (
        <div className="mcp-signin-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void openExternal(item.token_url!)}>
            Create a token
          </button>
        </div>
      )}
    </div>
  );
}

/** The sign-in of a "device" connector (Outlook): the account type, read-only, and the device code. */
function DeviceConnect({
  item,
  busy,
  code,
  onAction,
  onClose,
}: {
  item: ConnectorItem;
  busy: boolean;
  code: DeviceCode | null;
  onAction: (action: ConnectorAction) => void;
  onClose?: () => void;
}) {
  const accounts = item.accounts ?? [];
  const groupReadOnly = (type: ConnectorOptions["account"]) => accounts.find((a) => a.type === type)?.read_only ?? false;
  const [account, setAccountState] = useState<ConnectorOptions["account"]>("personal");
  const [readOnly, setReadOnly] = useState(() => groupReadOnly("personal"));
  const setAccount = (value: ConnectorOptions["account"]) => {
    setAccountState(value);
    setReadOnly(groupReadOnly(value));
  };
  const sameType = accounts.filter((a) => a.type === account).length;
  const [copied, setCopied] = useState(false);
  if (busy || item.signing_in) {
    return (
      <div className="mcp-signin">
        {code ? (
          <>
            <p className="help">
              Open <span className="mono">{code.url}</span> and enter this code. Sign in with your Microsoft account. Harness connects when the
              sign-in completes.
            </p>
            <p className="device-code mono" aria-label="Device code">
              {code.code}
            </p>
            <div className="mcp-signin-actions">
              <button
                type="button"
                className="btn btn-small btn-primary"
                onClick={() =>
                  void navigator.clipboard.writeText(code.code).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? "Copied" : "Copy code"}
              </button>
              {/^https:\/\//.test(code.url) && (
                <button type="button" className="btn btn-small" onClick={() => void openExternal(code.url)}>
                  Open sign-in page
                </button>
              )}
              <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "cancel", id: item.id })}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="help">
              <LoaderCircle size={13} className="spin" aria-hidden /> Starting the sign-in. The first start downloads the server from npm.
            </p>
            <div className="mcp-signin-actions">
              <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "cancel", id: item.id })}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mcp-signin">
      <div className="mcp-signin-actions" role="radiogroup" aria-label="Account type">
        {(Object.keys(ACCOUNT_NAMES) as ConnectorOptions["account"][]).map((value) => (
          <label key={value} className="checkbox">
            <input type="radio" name={`${item.id}-account`} checked={account === value} onChange={() => setAccount(value)} />
            {ACCOUNT_NAMES[value]}
          </label>
        ))}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        Read-only: the agent can read mail and events, but not send, change, or delete them
      </label>
      {sameType > 0 && (
        <p className="help">Read-only applies to all your {ACCOUNT_NAMES[account].toLowerCase()}s. They share one MCP server.</p>
      )}
      <div className="mcp-signin-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => onAction({ kind: "connect", id: item.id, source: "device", options: { account, read_only: readOnly } })}
        >
          {accounts.length > 0 ? "Sign in to another account" : "Sign in with Microsoft"}
        </button>
        {onClose && (
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
      <p className="help">
        Harness runs <code>{item.package}</code> with npx on the daemon computer, so the daemon computer needs Node.js. The server keeps its own
        sign-in in its encrypted cache there.
      </p>
    </div>
  );
}

/**
 * The "Continue with Google" button, made to the "Sign in with Google" branding guidelines
 * (developers.google.com/identity/branding-guidelines): the standard color "G" from the official sample
 * SVG, unchanged, at 20px; 12px before the logo, 10px after it, 12px after the text; a 1px inside stroke;
 * the light colors in the light theme and the dark colors in the dark theme (styles.css, .gsi-button).
 */
function GoogleButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="gsi-button" disabled={disabled} onClick={onClick}>
      <svg className="gsi-logo" width="20" height="20" viewBox="10 10 20 20" aria-hidden focusable="false">
        <path
          d="M29.6 20.2273C29.6 19.5182 29.5364 18.8364 29.4182 18.1818H20V22.05H25.3818C25.15 23.3 24.4455 24.3591 23.3864 25.0682V27.5773H26.6182C28.5091 25.8364 29.6 23.2727 29.6 20.2273Z"
          fill="#4285F4"
        />
        <path
          d="M20 30C22.7 30 24.9636 29.1045 26.6181 27.5773L23.3863 25.0682C22.4909 25.6682 21.3454 26.0227 20 26.0227C17.3954 26.0227 15.1909 24.2636 14.4045 21.9H11.0636V24.4909C12.7091 27.7591 16.0909 30 20 30Z"
          fill="#34A853"
        />
        <path
          d="M14.4045 21.9C14.2045 21.3 14.0909 20.6591 14.0909 20C14.0909 19.3409 14.2045 18.7 14.4045 18.1V15.5091H11.0636C10.3864 16.8591 10 18.3864 10 20C10 21.6136 10.3864 23.1409 11.0636 24.4909L14.4045 21.9Z"
          fill="#FBBC04"
        />
        <path
          d="M20 13.9773C21.4681 13.9773 22.7863 14.4818 23.8227 15.4727L26.6909 12.6045C24.9591 10.9909 22.6954 10 20 10C16.0909 10 12.7091 12.2409 11.0636 15.5091L14.4045 18.1C15.1909 15.7364 17.3954 13.9773 20 13.9773Z"
          fill="#E94235"
        />
      </svg>
      <span className="gsi-text">{label}</span>
    </button>
  );
}

/** The sign-in of a "google" connector (Gmail): the Google client of Harness or of the user, then a browser sign-in. */
function GoogleConnect({
  item,
  busy,
  code,
  onAction,
  onClose,
}: {
  item: ConnectorItem;
  busy: boolean;
  code: DeviceCode | null;
  onAction: (action: ConnectorAction) => void;
  onClose?: () => void;
}) {
  const accounts = item.accounts ?? [];
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [pasted, setPasted] = useState("");
  const [useOwn, setUseOwn] = useState(false);
  if (busy || item.signing_in) {
    return (
      <div className="mcp-signin">
        <p className="help">
          {code ? "Sign in with your Google account on the page that opened in your browser." : "Starting the sign-in."} Harness connects
          when the sign-in completes.
        </p>
        <div className="mcp-signin-actions">
          {code && /^https:\/\//.test(code.url) && (
            <button type="button" className="btn btn-small" onClick={() => void openExternal(code.url)}>
              Open sign-in page
            </button>
          )}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "cancel", id: item.id })}>
            Cancel
          </button>
        </div>
        {code && (
          <>
            <p className="help">If the browser shows an error page after the sign-in, copy the URL from its address bar and paste it here.</p>
            <form
              className="field-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!pasted.trim()) return;
                onAction({ kind: "auth_code", id: item.id, url: pasted.trim() });
                setPasted("");
              }}
            >
              <input
                className="mono"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="http://127.0.0.1:…/?code=…"
                aria-label={`Callback URL for ${item.name}`}
                spellCheck={false}
              />
              <button type="submit" className="btn" disabled={!pasted.trim()}>
                Submit
              </button>
            </form>
          </>
        )}
      </div>
    );
  }
  const hasClient = !!item.client_id || !!item.client_builtin;
  const own = !hasClient && (!item.builtin_client || useOwn);
  const ready = hasClient || !own || (clientId.trim() !== "" && clientSecret.trim() !== "");
  const options: GoogleConnectOptions = hasClient
    ? { read_only: readOnly }
    : own
      ? { client_id: clientId.trim(), client_secret: clientSecret.trim(), read_only: readOnly }
      : { builtin: true, read_only: readOnly };
  return (
    <div className="mcp-signin">
      {hasClient ? (
        <p className="help">
          OAuth client: {item.client_builtin ? "Harness" : <span className="mono">{item.client_id}</span>}
        </p>
      ) : !own ? null : (
        <>
          <p className="help">
            {item.builtin_client
              ? "To use an OAuth client of your own, do these steps once:"
              : "Gmail needs an OAuth client of your own, because this build of Harness has no Google client. Once:"}
          </p>
          <ol className="help connector-steps">
            <li>In Google Cloud, make a project and turn on the Gmail API.</li>
            <li>On the Google Auth Platform page, set the audience to External and publish the app ("In production"). In testing, Google stops the sign-in after 7 days.</li>
            <li>Make an OAuth client of the type "Desktop app", and paste its ID and secret here.</li>
          </ol>
          <div className="mcp-signin-actions">
            <button type="button" className="btn btn-small btn-ghost" onClick={() => item.token_url && void openExternal(item.token_url)}>
              Open Google Cloud
            </button>
          </div>
          <input className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="OAuth client ID" spellCheck={false} />
          <input
            type="password"
            className="mono"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client secret"
            aria-label="OAuth client secret"
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
      {accounts.length === 0 ? (
        <label className="checkbox">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Read-only: the agent can read mail, but not send, change, or delete it
        </label>
      ) : (
        <p className="help">{accounts[0].read_only ? "The accounts are read-only." : "The accounts can send, change, and delete mail."}</p>
      )}
      <p className="help">
        {own || (hasClient && !item.client_builtin)
          ? "Google shows a warning that the app is not verified. It is your own app, so you can continue."
          : "Google can show a warning that Harness is not verified yet. You can continue."}
      </p>
      <div className="mcp-signin-actions">
        <GoogleButton label="Continue with Google" disabled={!ready} onClick={() => onAction({ kind: "connect", id: item.id, source: "google", options })} />
        {onClose && (
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
      {!hasClient && item.builtin_client && (
        <div className="mcp-signin-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setUseOwn((v) => !v)}>
            {useOwn ? "Use the Harness client" : "Use your own OAuth client"}
          </button>
        </div>
      )}
      <p className="help">
        Harness runs <code>{item.package}</code> with uvx on the daemon computer, so the daemon computer needs uv. Harness keeps the tokens and the
        client secret on the daemon computer, not in mcp.json.
      </p>
    </div>
  );
}

/** The setup of a "local" connector (Chrome): the Chrome window of the user, or a separate profile. */
function LocalConnect({ item, busy, onAction }: { item: ConnectorItem; busy: boolean; onAction: (action: ConnectorAction) => void }) {
  const [profile, setProfile] = useState<"own" | "separate">("own");
  return (
    <div className="mcp-signin">
      <div className="mcp-signin-actions" role="radiogroup" aria-label="Chrome profile">
        {(Object.keys(CHROME_PROFILES) as ("own" | "separate")[]).map((value) => (
          <label key={value} className="checkbox">
            <input type="radio" name={`${item.id}-profile`} checked={profile === value} onChange={() => setProfile(value)} />
            {CHROME_PROFILES[value]}
          </label>
        ))}
      </div>
      {profile === "own" ? (
        <p className="help">
          The agent uses the Chrome that you have open, with its signed-in accounts. Chrome 144 or newer: open{" "}
          <span className="mono">chrome://inspect/#remote-debugging</span> and turn on remote debugging. Chrome asks you to allow each connection.
        </p>
      ) : (
        <p className="help">The agent starts a Chrome with a profile of its own. It has none of your accounts or cookies.</p>
      )}
      <div className="mcp-signin-actions">
        <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => onAction({ kind: "connect", id: item.id, source: "local", profile })}>
          Connect
        </button>
      </div>
      <p className="help">
        Harness runs <code>{item.package}</code> with npx on the daemon computer, so the daemon computer needs Node.js and Chrome.
      </p>
    </div>
  );
}

/** The accounts of a device connector (Outlook), each with "Remove", and "Add account". */
function DeviceAccounts({
  item,
  busy,
  code,
  onAction,
}: {
  item: ConnectorItem;
  busy: boolean;
  code: DeviceCode | null;
  onAction: (action: ConnectorAction) => void;
}) {
  const [adding, setAdding] = useState(false);
  const accounts = item.accounts ?? [];
  useEffect(() => {
    if (!busy && !item.signing_in) setAdding(false);
  }, [busy, item.signing_in, accounts.length]);
  if (adding || busy || item.signing_in) {
    return item.kind === "google" ? (
      <GoogleConnect item={item} busy={busy} code={code} onAction={onAction} onClose={() => setAdding(false)} />
    ) : (
      <DeviceConnect item={item} busy={busy} code={code} onAction={onAction} onClose={() => setAdding(false)} />
    );
  }
  return (
    <>
      <ul className="connector-accounts" aria-label={`Accounts of ${item.name}`}>
        {accounts.map((a) => (
          <li key={a.login}>
            <span className="connector-account-name">{a.login}</span>
            <span className="help">
              {accountName(a.type)}
              {a.read_only ? " · read-only" : ""}
            </span>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => onAction({ kind: "remove_account", id: item.id, login: a.login })}
              aria-label={`Remove ${a.login}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <p className="help">
        {accounts.length > 1
          ? "The agent names the account in each tool call. Each tool call needs approval, unless a rule allows it,"
          : "Each tool call needs approval, unless a rule allows it,"}{" "}
        for example <code>mcp__{item.id}__*</code>.
      </p>
      <div className="mcp-signin-actions">
        <button type="button" className="btn btn-small" onClick={() => setAdding(true)}>
          Add account
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "disconnect", id: item.id })}>
          {accounts.length > 1 ? "Disconnect all" : "Disconnect"}
        </button>
      </div>
    </>
  );
}

function ConnectorRow({
  item,
  busy,
  error,
  code,
  onAction,
}: {
  item: ConnectorItem;
  busy: boolean;
  error: string | null;
  code: DeviceCode | null;
  onAction: (action: ConnectorAction) => void;
}) {
  const connected = item.source !== null;
  // All rows start collapsed (the user asked for this). A device code opens its row.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (code) setOpen(true);
  }, [code]);
  const status: CapabilityStatus = busy || item.signing_in ? "connecting" : connected ? "linked" : "unlinked";
  return (
    <li className={`cap-item${open ? " open" : ""}`}>
      <div className="cap-row-wrap">
        <button type="button" className="cap-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`cap-icon${hasConnectorLogo(item.id) ? " cap-logo" : ""}`} aria-hidden>
            <ConnectorLogo id={item.id} size={16} />
          </span>
          <span className="cap-text">
            <span className="cap-name">{item.name}</span>
            <span className="cap-desc">{connectorSummary(item)}</span>
          </span>
          <StatusPill status={status} />
          <ChevronRight size={14} aria-hidden className="cap-chevron" />
        </button>
      </div>
      {open && (
        <div className="cap-more">
          <p className="mcp-target mono" title={item.url}>
            {item.url}
          </p>
          {error && (
            <div className="notice-bar bad" role="alert">
              <CircleX size={15} aria-hidden />
              <span>{error}</span>
            </div>
          )}
          {(item.kind === "device" || item.kind === "google") && (item.accounts?.length ?? 0) > 0 ? (
            <DeviceAccounts item={item} busy={busy} code={code} onAction={onAction} />
          ) : connected && !busy ? (
            <>
              <p className="help">
                The MCP server "{item.id}" is in your mcp.json, for all your projects. Each tool call needs approval, unless a rule
                allows it, for example <code>mcp__{item.id}__*</code>.
              </p>
              {item.profile === "own" && (
                <p className="help">
                  Turn on remote debugging in <span className="mono">chrome://inspect/#remote-debugging</span> (Chrome 144 or newer). Chrome asks you to
                  allow each connection.
                </p>
              )}
              <div className="mcp-signin-actions">
                <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "disconnect", id: item.id })}>
                  Disconnect
                </button>
              </div>
            </>
          ) : item.kind === "device" ? (
            <DeviceConnect item={item} busy={busy} code={code} onAction={onAction} />
          ) : item.kind === "google" ? (
            <GoogleConnect item={item} busy={busy} code={code} onAction={onAction} />
          ) : item.kind === "local" ? (
            <LocalConnect item={item} busy={busy} onAction={onAction} />
          ) : (
            <TokenConnect item={item} busy={busy} onAction={onAction} />
          )}
        </div>
      )}
    </li>
  );
}

/** The tabs of the page. Connectors ("connections") sets up MCP servers with a token (connectors.py). */
export type CapTab = "skills" | "mcp" | "plugins" | "connections";

/** The saved tab, or "skills" for an unknown value. */
export function toCapTab(value: string): CapTab {
  return value === "mcp" || value === "plugins" || value === "connections" ? value : "skills";
}

export const CapabilitiesPage = memo(function CapabilitiesPage({
  tab,
  onTab,
  folder,
  live,
  skills,
  skillDetail,
  mcp,
  mcpBusy,
  plugins,
  pluginsTab,
  onOpenSkill,
  onBack,
  onRestart,
  onMcpAuth,
  connectors,
  connectorBusy,
  connectorError,
  deviceCode,
  onConnector,
  onEditConfig,
}: {
  tab: CapTab;
  onTab: (tab: CapTab) => void;
  folder: string | null; // The project folder. null: only the skills and servers of the user.
  live: boolean; // A session is open in the folder: the MCP states are live.
  skills: CommandItem[] | null;
  skillDetail: SkillDetail | null | "loading";
  mcp: McpStatus | null;
  mcpBusy: boolean;
  plugins: PluginsStatus | null; // For the count and the red dot of the tab.
  pluginsTab: React.ReactNode; // The content of the Plugins tab (PluginsScreen).
  onOpenSkill: (name: string) => void;
  onBack: () => void;
  onRestart: (name?: string) => void;
  onMcpAuth: (action: McpAuthAction) => void;
  connectors: ConnectorItem[] | null;
  connectorBusy: string | null; // The id of the connector that connects now.
  connectorError: { id: string; message: string } | null;
  deviceCode: DeviceCode | null;
  onConnector: (action: ConnectorAction) => void;
  onEditConfig: () => void;
}) {
  const [query, setQuery] = useState("");
  const [skillGroup, setSkillGroup] = useState<SkillGroup | null>(null);
  const groupSkills = useMemo(() => (skills && skillGroup ? skillsOfGroup(skills, skillGroup) : []), [skills, skillGroup]);
  const shownSkills = useMemo(() => groupSkills.filter((i) => matches(query, i.name, i.description)), [groupSkills, query]);
  const group = SKILL_GROUPS.find((g) => g.id === skillGroup);
  const shownServers = useMemo(
    () => (mcp?.items ?? []).filter((i) => matches(query, i.name, i.target, ...i.tools.map((t) => t.agent_name || t.name))),
    [mcp, query],
  );
  const connected = mcp?.items.filter((i) => i.state === "connected").length ?? 0;
  const failed = mcp?.items.filter((i) => i.state === "failed").length ?? 0;
  const pluginsFailed =
    plugins?.bundles.filter((b) => b.problem || b.rows.some((r) => r.state === "failed")).length ?? 0;
  const folderName = folder?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  const filtering = query.trim() !== "";

  const filterField = (
    <div className="skills-search cap-search">
      <Search size={14} aria-hidden />
      <label htmlFor="capabilities-filter" className="sr-only">
        {tab === "skills" ? "Filter the skills" : "Filter the MCP servers"}
      </label>
      <input id="capabilities-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" spellCheck={false} />
    </div>
  );

  let body: React.ReactNode;
  if (skillDetail === "loading") {
    body = (
      <p className="cap-empty">
        <LoaderCircle size={16} className="spin" aria-hidden /> Loading the skill.
      </p>
    );
  } else if (skillDetail) {
    body = <SkillView detail={skillDetail} onBack={onBack} />;
  } else {
    body = (
      <>
        {tab === "mcp" && filterField}

        {tab === "skills" && !group && (
          <section className="cap-section" aria-labelledby="cap-skills">
            <SectionHead id="cap-skills" title="Skills" />
            {skills === null ? (
              <p className="cap-empty">
                <LoaderCircle size={14} className="spin" aria-hidden /> Loading the skills.
              </p>
            ) : (
              <ul className="cap-list">
                {SKILL_GROUPS.map((g) => (
                  <SkillGroupRow
                    key={g.id}
                    title={g.title}
                    desc={g.desc}
                    icon={g.icon}
                    count={skillsOfGroup(skills, g.id).length}
                    onOpen={() => {
                      setQuery("");
                      setSkillGroup(g.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === "skills" && group && (
          <section className="cap-section" aria-labelledby="cap-skills">
            <button type="button" className="btn btn-small cap-back" onClick={() => setSkillGroup(null)}>
              <ArrowLeft size={14} aria-hidden />
              Skills
            </button>
            <SectionHead id="cap-skills" title={group.title} count={groupSkills.length > 0 ? String(groupSkills.length) : undefined} />
            {groupSkills.length > 0 && filterField}
            {skills === null ? (
              <p className="cap-empty">
                <LoaderCircle size={14} className="spin" aria-hidden /> Loading the skills.
              </p>
            ) : groupSkills.length === 0 ? (
              group.id === "added" ? (
                <p className="cap-empty">
                  No skills are added. Put each skill in a folder with a <code>SKILL.md</code> file, in <code>.harness/skills/</code> or{" "}
                  <code>.claude/skills/</code> of the project, or in <code>~/.harness/skills/</code> or <code>~/.claude/skills/</code>.
                </p>
              ) : (
                <p className="cap-empty">No built-in skills are available. An added skill with the same name replaces a built-in skill.</p>
              )
            ) : shownSkills.length === 0 ? (
              <p className="cap-empty">No skill matches the filter.</p>
            ) : (
              <ul className="cap-list">
                {shownSkills.map((item) => (
                  <SkillRow key={item.name} item={item} onOpen={() => onOpenSkill(item.name)} />
                ))}
              </ul>
            )}
            {group.id === "builtin" && !filtering && groupSkills.length > 0 && (
              <p className="help cap-note">
                The agent uses these skills when a task matches. Their scripts run with your Python. An added skill with the same name replaces a
                built-in skill.
              </p>
            )}
          </section>
        )}

        {tab === "mcp" && (
        <section className="cap-section" aria-labelledby="cap-mcp">
          <SectionHead
            id="cap-mcp"
            title="MCP servers"
            count={
              mcp && mcp.items.length > 0
                ? live
                  ? `${connected} of ${mcp.items.length} connected${failed ? ` · ${failed} failed` : ""}`
                  : String(mcp.items.length)
                : undefined
            }
          >
            {mcpBusy && <LoaderCircle size={14} className="spin" aria-label="Busy" />}
            {live && (
              <>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onRestart()}
                  disabled={mcpBusy || mcp === null}
                  title="Read mcp.json again and connect to all servers again"
                >
                  <RefreshCw size={12} aria-hidden /> Reload all
                </button>
                <button type="button" className="btn btn-small" onClick={onEditConfig} title="Open .harness/mcp.json of the project in the editor">
                  <FileCog size={13} aria-hidden /> Edit mcp.json
                </button>
              </>
            )}
          </SectionHead>
          {mcp === null ? (
            <p className="cap-empty">
              <LoaderCircle size={14} className="spin" aria-hidden /> Loading the MCP servers.
            </p>
          ) : (
            <>
              {mcp.problems.map((p, i) => (
                <div key={i} className="notice-bar warn" role="alert">
                  <TriangleAlert size={15} aria-hidden />
                  <span>{p}</span>
                </div>
              ))}
              {mcp.items.length === 0 ? (
                <div className="cap-empty">
                  <p>No MCP servers are configured.</p>
                  {live && (
                    <button type="button" className="btn btn-small" onClick={onEditConfig}>
                      <FileCog size={13} aria-hidden /> Create .harness/mcp.json
                    </button>
                  )}
                </div>
              ) : shownServers.length === 0 ? (
                <p className="cap-empty">No MCP server matches the filter.</p>
              ) : (
                <ul className="cap-list">
                  {shownServers.map((item) => (
                    <McpRow
                      key={item.name}
                      item={item}
                      live={live}
                      busy={mcpBusy}
                      onRestart={() => onRestart(item.name)}
                      onAuth={onMcpAuth}
                      onOpenConnectors={() => onTab("connections")}
                    />
                  ))}
                </ul>
              )}
              {!filtering && (
                <p className="help cap-note">
                  The servers come from <code>{mcp.paths.project}</code> in the project and from <code>{mcp.paths.user}</code>. A project
                  server replaces a user server with the same name. Each MCP tool call needs approval, unless a rule allows it, for example{" "}
                  <code>mcp__github__*</code>.
                  {!live && " Open a session in this folder to connect the servers, restart them, or edit mcp.json."}
                </p>
              )}
            </>
          )}
        </section>
        )}

        {tab === "plugins" && pluginsTab}

        {tab === "connections" && (
          <section className="cap-section" aria-labelledby="cap-connections">
            <SectionHead
              id="cap-connections"
              title="Connectors"
              count={connectors ? `${connectors.filter((c) => c.source).length} of ${connectors.length} connected` : undefined}
            />
            {connectors === null ? (
              <p className="cap-empty">
                <LoaderCircle size={14} className="spin" aria-hidden /> Loading the connectors.
              </p>
            ) : (
              <ul className="cap-list">
                {connectors.map((item) => (
                  <ConnectorRow
                    key={item.id}
                    item={item}
                    busy={connectorBusy === item.id}
                    error={connectorError?.id === item.id ? connectorError.message : null}
                    code={deviceCode?.id === item.id ? deviceCode : null}
                    onAction={onConnector}
                  />
                ))}
              </ul>
            )}
            <p className="help cap-note">
              A connector adds an MCP server to <code>~/.harness/mcp.json</code> on the daemon computer, for all your projects. mcp.json has no
              tokens: Harness keeps them in <code>~/.harness/mcp-auth.json</code>, and a local server such as Outlook keeps its own sign-in.
            </p>
          </section>
        )}
      </>
    );
  }

  return (
    <div className="cap-page">
      <div className="cap-page-inner">
        <header className="cap-page-head">
          <h1 id="capabilities-title">Capabilities</h1>
          <p className="help">
            {folderName ? (
              <>
                The skills, MCP servers, and plugins {live ? "of this session" : "for new sessions"} in <span title={folder ?? undefined}>{folderName}</span>.
              </>
            ) : (
              "Your skills, MCP servers, and plugins. Open a project to see its skills and servers too."
            )}
          </p>
        </header>
        {!skillDetail && (
          <div className="cap-tabs" role="tablist" aria-label="Capabilities">
            {CAP_TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`cap-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="cap-tab-panel"
                className={`cap-tab${tab === id ? " active" : ""}`}
                onClick={() => onTab(id)}
              >
                {label}
                {id === "skills" && skills && skills.length > 0 && <span className="cap-tab-count">{skills.length}</span>}
                {id === "mcp" && mcp && mcp.items.length > 0 && <span className="cap-tab-count">{mcp.items.length}</span>}
                {id === "mcp" && failed > 0 && <span className="cap-tab-dot" role="img" aria-label={`${failed} failed`} />}
                {id === "plugins" && plugins && plugins.bundles.length > 0 && <span className="cap-tab-count">{plugins.bundles.length}</span>}
                {id === "plugins" && pluginsFailed > 0 && <span className="cap-tab-dot" role="img" aria-label={`${pluginsFailed} failed`} />}
              </button>
            ))}
          </div>
        )}
        <div role={skillDetail ? "region" : "tabpanel"} id="cap-tab-panel" aria-labelledby={skillDetail ? "capabilities-title" : `cap-tab-${tab}`}>
          {body}
        </div>
      </div>
    </div>
  );
});
