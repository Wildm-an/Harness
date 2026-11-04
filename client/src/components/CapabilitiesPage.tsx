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
import type { CommandItem, ConnectorItem, ConnectorOptions, McpServerItem, McpState, McpStatus, PluginsStatus, SkillDetail } from "../daemon/protocol";

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
  | { kind: "cancel"; id: string }
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

/** The short description of a connector: the account and the token source, or what it gives. */
export function connectorSummary(item: ConnectorItem): string {
  if (!item.source) return item.description;
  if (item.source === "device") {
    const parts = [item.login ?? "Connected"];
    if (item.options) parts.push(ACCOUNT_NAMES[item.options.account]);
    if (item.options?.read_only) parts.push("read-only");
    return parts.join(" · ");
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
}: {
  item: ConnectorItem;
  busy: boolean;
  code: DeviceCode | null;
  onAction: (action: ConnectorAction) => void;
}) {
  const [account, setAccount] = useState<ConnectorOptions["account"]>("personal");
  const [readOnly, setReadOnly] = useState(false);
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
      <div className="mcp-signin-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => onAction({ kind: "connect", id: item.id, source: "device", options: { account, read_only: readOnly } })}
        >
          Sign in with Microsoft
        </button>
      </div>
      <p className="help">
        Harness runs <code>{item.package}</code> with npx on the daemon computer, so the daemon computer needs Node.js. The server keeps its own
        sign-in in its encrypted cache there.
      </p>
    </div>
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
  const [open, setOpen] = useState(!connected);
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
          {connected && !busy ? (
            <>
              <p className="help">
                The MCP server "{item.id}" is in your mcp.json, for all your projects. Each tool call needs approval, unless a rule
                allows it, for example <code>mcp__{item.id}__*</code>.
              </p>
              <div className="mcp-signin-actions">
                <button type="button" className="btn btn-small btn-ghost" onClick={() => onAction({ kind: "disconnect", id: item.id })}>
                  Disconnect
                </button>
              </div>
            </>
          ) : item.kind === "device" ? (
            <DeviceConnect item={item} busy={busy} code={code} onAction={onAction} />
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
