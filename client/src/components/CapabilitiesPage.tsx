// The Capabilities page: the skills, the MCP servers, and the plugins on tabs, as the "Customize" page
// of the Claude app and the Skills and MCP pages of the Hermes dashboard show them. The "Capabilities"
// item in the sidebar opens it. Each row shows the name, a short description, and the status. A skill
// row opens the skill. An MCP row opens its tools, its target, and its error.

import { memo, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  FileCog,
  FileText,
  LoaderCircle,
  Plug,
  RefreshCw,
  Search,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { SlashIcon } from "./SlashIcon";
import { Markdown } from "./Markdown";
import type { CommandItem, McpServerItem, McpState, McpStatus, PluginsStatus, SkillDetail } from "../daemon/protocol";

export type CapabilityStatus = "connected" | "connecting" | "failed" | "disabled" | "stopped" | "enabled" | "command" | "model";

const STATUS: Record<CapabilityStatus, { label: string; tone: "ok" | "busy" | "bad" | "off"; icon: LucideIcon; tip: string }> = {
  connected: { label: "Connected", tone: "ok", icon: CircleCheck, tip: "The server is connected. The agent can use its tools." },
  connecting: { label: "Connecting", tone: "busy", icon: LoaderCircle, tip: "The server starts." },
  failed: { label: "Failed", tone: "bad", icon: CircleX, tip: "The server did not start. Open the row to see the error." },
  disabled: { label: "Disabled", tone: "off", icon: CircleSlash, tip: "The configuration turns off this server." },
  stopped: { label: "Not connected", tone: "off", icon: Plug, tip: "The server connects when a session starts in this folder." },
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
  ["mcp", "MCP servers"],
  ["plugins", "Plugins"],
  ["connections", "Connections"],
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
      <Icon size={13} aria-hidden className={status === "connecting" ? "spin" : undefined} />
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

function McpRow({ item, live, busy, onRestart }: { item: McpServerItem; live: boolean; busy: boolean; onRestart: () => void }) {
  // A failed server opens at once, so the error shows.
  const [open, setOpen] = useState(item.state === "failed");
  const status = MCP_STATUS[item.state];
  return (
    <li className={`cap-item${open ? " open" : ""}`}>
      <div className="cap-row-wrap">
        <button type="button" className="cap-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`cap-icon${status === "failed" ? " bad" : ""}`} aria-hidden>
            <Plug size={15} />
          </span>
          <span className="cap-text">
            <span className="cap-name">{item.name}</span>
            <span className="cap-desc">{item.error && !open ? item.error : mcpSummary(item)}</span>
          </span>
          <StatusPill status={status} />
          <ChevronRight size={14} aria-hidden className="cap-chevron" />
        </button>
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

/** The tabs of the page. Connections is a placeholder: the user adds it later. */
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
  onEditConfig: () => void;
}) {
  const [query, setQuery] = useState("");
  const shownSkills = useMemo(() => (skills ?? []).filter((i) => matches(query, i.name, i.description)), [skills, query]);
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
        {(tab === "skills" || tab === "mcp") && (
          <div className="skills-search cap-search">
            <Search size={14} aria-hidden />
            <label htmlFor="capabilities-filter" className="sr-only">
              {tab === "skills" ? "Filter the skills" : "Filter the MCP servers"}
            </label>
            <input id="capabilities-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" spellCheck={false} />
          </div>
        )}

        {tab === "skills" && (
        <section className="cap-section" aria-labelledby="cap-skills">
          <SectionHead id="cap-skills" title="Skills" count={skills && skills.length > 0 ? String(skills.length) : undefined} />
          {skills === null ? (
            <p className="cap-empty">
              <LoaderCircle size={14} className="spin" aria-hidden /> Loading the skills.
            </p>
          ) : skills.length === 0 ? (
            <p className="cap-empty">
              No skills are installed. Put each skill in a folder with a <code>SKILL.md</code> file, in <code>.harness/skills/</code> or{" "}
              <code>.claude/skills/</code> of the project, or in <code>~/.harness/skills/</code> or <code>~/.claude/skills/</code>.
            </p>
          ) : shownSkills.length === 0 ? (
            <p className="cap-empty">No skill matches the filter.</p>
          ) : (
            <ul className="cap-list">
              {shownSkills.map((item) => (
                <SkillRow key={item.name} item={item} onOpen={() => onOpenSkill(item.name)} />
              ))}
            </ul>
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
                    <McpRow key={item.name} item={item} live={live} busy={mcpBusy} onRestart={() => onRestart(item.name)} />
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
            <SectionHead id="cap-connections" title="Connections" />
            <div className="cap-empty">
              <p>Connections are not ready yet. This tab will show the apps and services that the agent can connect to.</p>
            </div>
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
