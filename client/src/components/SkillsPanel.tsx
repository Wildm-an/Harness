import { memo, useMemo, useState } from "react";
import { ArrowLeft, FileText, LoaderCircle, Search, Sparkles, X } from "lucide-react";
import type { CommandItem, SkillDetail } from "../daemon/protocol";
import { Markdown } from "./Markdown";

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: "", body: text };
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
        All skills
      </button>
      <h3 className="mono">/{detail.name}</h3>
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

export const SkillsPanel = memo(function SkillsPanel({
  items,
  detail,
  onOpen,
  onBack,
  onClose,
}: {
  items: CommandItem[] | null;
  detail: SkillDetail | null | "loading";
  onOpen: (name: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <section className="side-pane skills-panel" aria-label="Skills">
      <header className="pane-head">
        <Sparkles size={16} aria-hidden className="pane-icon" />
        <span className="pane-title">Skills{items ? ` (${items.length})` : ""}</span>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close skills" title="Close">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="pane-body">
        {detail === "loading" ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the skill.
          </p>
        ) : detail ? (
          <SkillView detail={detail} onBack={onBack} />
        ) : items === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the skills.
          </p>
        ) : items.length === 0 ? (
          <div className="pane-empty-block">
            <p>No skills are installed.</p>
            <p className="help">
              Put each skill in a folder with a <code>SKILL.md</code> file, in <code>.harness/skills/</code> or{" "}
              <code>.claude/skills/</code> of the project, or in <code>~/.harness/skills/</code> or{" "}
              <code>~/.claude/skills/</code>.
            </p>
          </div>
        ) : (
          <>
            <div className="skills-search">
              <Search size={14} aria-hidden />
              <label htmlFor="skills-filter" className="sr-only">
                Filter the skills
              </label>
              <input
                id="skills-filter"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter"
                spellCheck={false}
              />
            </div>
            <ul className="skills-list">
              {shown.map((item) => (
                <li key={item.name}>
                  <button type="button" className="skill-item" onClick={() => onOpen(item.name)}>
                    <span className="skill-item-head">
                      <span className="mono skill-name">/{item.name}</span>
                      <span className="skill-source">{item.source}</span>
                    </span>
                    <span className="skill-desc">{item.description}</span>
                    <Badges item={item} />
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="rules-empty">No skill matches the filter.</li>}
            </ul>
          </>
        )}
      </div>
    </section>
  );
});
