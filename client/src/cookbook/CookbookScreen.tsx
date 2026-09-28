import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChefHat,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Heart,
  KeyRound,
  LoaderCircle,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Square,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { DownloadItem, FitDetail, FitResult, HfDetail, HfFileGroup, InstalledRepo, ServeItem } from "../daemon/protocol";
import { Markdown } from "../components/Markdown";
import { loadPref, savePref } from "../lib/prefs";
import { isTauri, openExternal } from "../lib/tauri";
import { formatBytes, formatCount, formatParams, formatTokens, type CookbookApi } from "./useCookbook";

type Tab = "models" | "downloads" | "installed" | "served" | "hosts";

const TABS: { id: Tab; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "downloads", label: "Downloads" },
  { id: "installed", label: "Installed" },
  { id: "served", label: "Served" },
  { id: "hosts", label: "Hosts and settings" },
];

const PARAMS = [
  { value: "", label: "Any size" },
  { value: "3B", label: "Up to 3B" },
  { value: "7B", label: "7B (3–9B)" },
  { value: "14B", label: "14B (9–20B)" },
  { value: "32B", label: "32B (20–40B)" },
  { value: "70B", label: "70B and more" },
];

const SORTS = [
  { value: "downloads", label: "Downloads" },
  { value: "likes", label: "Likes" },
  { value: "trending", label: "Trending" },
  { value: "updated", label: "Last update" },
];

const FIT_LABEL: Record<FitResult, string> = { fits: "Fits in VRAM", offload: "CPU offload", no: "Does not fit" };

/** Groups the files of an installed model: the parts of a split GGUF file are one model. */
export function groupInstalled(files: InstalledRepo["files"]): { name: string; label: string; files: string[]; size: number }[] {
  const groups = new Map<string, { name: string; label: string; files: string[]; size: number }>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const split = /-(\d{5})-of-(\d{5})(?=\.gguf$)/i.exec(f.name);
    const key = f.name.endsWith(".safetensors") ? "safetensors" : split ? f.name.replace(split[0], "") + `#${split[2]}` : f.name;
    const label = key === "safetensors" ? "safetensors (all files)" : split ? `${f.name.replace(split[0], "")} (${Number(split[2])} parts)` : f.name;
    const group = groups.get(key) ?? { name: f.name, label, files: [], size: 0 };
    group.files.push(f.name);
    group.size += f.size;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function FitBadge({ result, estimate, title }: { result: FitResult | null | undefined; estimate?: boolean; title?: string }) {
  if (!result) return null;
  return (
    <span className={`fit-badge fit-${result}`} title={title ?? (estimate ? "An estimate from the parameter count (Q4_K_M, 16K context)" : undefined)}>
      {estimate && "≈ "}
      {FIT_LABEL[result]}
    </span>
  );
}

function ErrorBar({ text, onClose }: { text: string | undefined; onClose?: () => void }) {
  if (!text) return null;
  return (
    <div className="notice-bar bad" role="alert">
      <TriangleAlert size={15} aria-hidden />
      <span>{text}</span>
      <span className="spacer" />
      {onClose && (
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close the message">
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function Progress({ d }: { d: DownloadItem }) {
  const share = d.bytes_total ? Math.min(1, d.bytes_done / d.bytes_total) : 0;
  return (
    <div className="dl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}
      aria-label={`Download of ${d.repo_id}`}>
      <div className={`dl-bar state-${d.state}`} style={{ width: `${share * 100}%` }} />
    </div>
  );
}

// -- the hardware bar -------------------------------------------------------------------------------

function HardwareBar({ api }: { api: CookbookApi }) {
  const hw = api.hardware;
  const error = api.errors["cookbook.hardware"];
  return (
    <div className="hw-bar" aria-live="polite">
      <Cpu size={15} aria-hidden className="hw-icon" />
      {hw === "loading" || (!hw && !error) ? (
        <span>
          <LoaderCircle size={13} className="spin" aria-hidden /> Reading the hardware.
        </span>
      ) : error && !hw ? (
        <span className="bad">{error}</span>
      ) : hw ? (
        <span className="hw-text">
          <span className="mono">{hw.hostname}</span>
          {hw.gpus.length ? (
            hw.gpus.map((g, i) => (
              <span key={i}>
                {g.name} · <strong>{formatBytes(g.vram_total)} VRAM</strong>
              </span>
            ))
          ) : (
            <span className="warn">No GPU found: models run on the CPU</span>
          )}
          <span>{formatBytes(hw.ram_total)} RAM</span>
          <span>{hw.cpu_cores} CPU cores</span>
          {!hw.llama_server && <span className="warn" title="Set the llama-server path in Hosts and settings">No llama-server</span>}
          {!hw.huggingface_hub && <span className="warn">No huggingface_hub</span>}
        </span>
      ) : null}
      <span className="spacer" />
      <button type="button" className="icon-btn ghost" onClick={api.refreshHardware} aria-label="Read the hardware again" title="Read the hardware again">
        <RefreshCw size={14} aria-hidden />
      </button>
    </div>
  );
}

// -- models -----------------------------------------------------------------------------------------

function SearchView({ api }: { api: CookbookApi }) {
  const s = api.search;
  const [query, setQuery] = useState(s.query);

  useEffect(() => {
    if (!s.done && !s.loading) api.runSearch({});
  }, []);

  return (
    <div className="cb-search">
      <form
        className="cb-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          api.runSearch({ query });
        }}
      >
        <label htmlFor="cb-query" className="sr-only">
          Search Hugging Face
        </label>
        <div className="field-row">
          <input id="cb-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Hugging Face, for example qwen coder" />
          <button type="submit" className="btn btn-primary">
            <Search size={14} aria-hidden />
            Search
          </button>
        </div>
        <div className="cb-filters">
          <label>
            Library
            <select value={s.filters.library} onChange={(e) => api.runSearch({ query, filters: { ...s.filters, library: e.target.value as "gguf" | "safetensors" } })}>
              <option value="gguf">GGUF (llama.cpp)</option>
              <option value="safetensors">safetensors (vLLM)</option>
            </select>
          </label>
          <label>
            Task
            <select value={s.filters.task ?? ""} onChange={(e) => api.runSearch({ query, filters: { ...s.filters, task: e.target.value || null } })}>
              <option value="text-generation">Text generation</option>
              <option value="image-text-to-text">Image and text</option>
              <option value="">Any task</option>
            </select>
          </label>
          <label>
            Size
            <select value={s.filters.params ?? ""} onChange={(e) => api.runSearch({ query, filters: { ...s.filters, params: e.target.value || null } })}>
              {PARAMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sort by
            <select value={s.sort} onChange={(e) => api.runSearch({ query, sort: e.target.value })}>
              {SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={s.filters.fit_only} onChange={(e) => api.runSearch({ query, filters: { ...s.filters, fit_only: e.target.checked } })} />
            Show only models that fit
          </label>
        </div>
      </form>
      <ErrorBar text={api.errors["hf.search"]} />
      {s.done && !s.hardware && (
        <p className="help">The fit badges need the hardware of the host. Read the hardware with the button above.</p>
      )}
      <ul className="cb-results" aria-label="Models">
        {s.items.map((m) => (
          <li key={m.repo_id}>
            <button type="button" className="cb-result" onClick={() => api.openModel(m.repo_id)}>
              <span className="cb-result-head">
                <span className="cb-name">
                  {m.gated && <Lock size={13} aria-label="Gated model" />}
                  {m.name}
                </span>
                <span className="cb-author">{m.author}</span>
                <span className="spacer" />
                <FitBadge result={m.fit} estimate />
              </span>
              <span className="cb-meta">
                {formatParams(m.params) && <span>{formatParams(m.params)} parameters</span>}
                {m.license && <span>{m.license}</span>}
                <span>
                  <Download size={12} aria-hidden /> {formatCount(m.downloads)}
                </span>
                <span>
                  <Heart size={12} aria-hidden /> {formatCount(m.likes)}
                </span>
                {m.last_modified && <span>Updated {new Date(m.last_modified).toLocaleDateString()}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {s.loading && (
        <p className="pane-empty">
          <LoaderCircle size={16} className="spin" aria-hidden /> Searching Hugging Face.
        </p>
      )}
      {!s.loading && s.done && s.items.length === 0 && <p className="pane-empty">No model matches the search.</p>}
      {!s.loading && s.hasMore && (
        <button type="button" className="btn btn-wide" onClick={api.moreResults}>
          Show more results
        </button>
      )}
    </div>
  );
}

function FitCell({ fit }: { fit: FitDetail | null }) {
  if (!fit) return <span className="help">No hardware</span>;
  const title = `Weights ${formatBytes(fit.weights)} + KV cache ${formatBytes(fit.kv_cache)} at ${formatTokens(fit.context)} + 10% = ${formatBytes(fit.total)}`;
  return (
    <span className="fit-cell">
      <FitBadge result={fit.result} estimate={fit.estimate} title={title} />
      <span className="help">{formatBytes(fit.total)}</span>
    </span>
  );
}

function DetailView({ api, detail, onServe }: { api: CookbookApi; detail: HfDetail; onServe: (file: string) => void }) {
  const installed = api.installed && api.installed !== "loading" ? api.installed.repos.find((r) => r.repo_id === detail.repo_id) : undefined;
  const have = new Set(installed?.files.map((f) => f.name) ?? []);

  useEffect(() => {
    if (!api.installed) api.loadInstalled();
  }, [detail.repo_id]);

  const downloadOf = (g: HfFileGroup) =>
    api.downloads.find((d) => d.repo_id === detail.repo_id && d.host === api.host && d.files.join() === g.files.join() && d.state !== "cancelled");

  return (
    <div className="cb-detail">
      <button type="button" className="btn btn-ghost" onClick={api.closeModel}>
        <ArrowLeft size={14} aria-hidden />
        Back to the results
      </button>
      <div className="cb-detail-head">
        <h2>{detail.repo_id}</h2>
        <button type="button" className="btn btn-small" onClick={() => void openExternal(detail.url)}>
          <ExternalLink size={13} aria-hidden />
          Open on Hugging Face
        </button>
      </div>
      <p className="cb-meta">
        {formatParams(detail.item.params) && <span>{formatParams(detail.item.params)} parameters</span>}
        {detail.item.license && <span>{detail.item.license}</span>}
        {detail.shape && (
          <span>
            {detail.shape.architecture} · {detail.shape.layers} layers · {detail.shape.kv_heads} KV heads
            {detail.shape.context_length ? ` · ${formatTokens(detail.shape.context_length)} context` : ""}
          </span>
        )}
      </p>
      {detail.gated && !detail.access && (
        <div className="notice-bar warn" role="alert">
          <Lock size={15} aria-hidden />
          <span>
            This model is gated. Accept its license on Hugging Face, then add a Hugging Face token in Hosts and settings.
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={() => void openExternal(detail.url)}>
            Open the model page
          </button>
        </div>
      )}
      {detail.shape_error && detail.access && <p className="help">{detail.shape_error} The fit results are estimates.</p>}
      <ErrorBar text={api.errors["hf.download"]} onClose={() => api.clearError("hf.download")} />

      <h3 className="cb-h3">Files</h3>
      <p className="help">
        The fit results are for a {formatTokens(16384)} context on the host <span className="mono">{api.host}</span>. “Max context” is the largest
        context that fits in VRAM.
      </p>
      {detail.files.length === 0 ? (
        <p className="pane-empty">This repository has no GGUF or safetensors files.</p>
      ) : (
        <div className="table-wrap">
          <table className="cb-files">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Quant</th>
                <th scope="col">Size</th>
                <th scope="col">Fit</th>
                <th scope="col">Max context</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.files.map((g) => {
                const d = downloadOf(g);
                const done = g.files.every((f) => have.has(f));
                const recommended = g.name === detail.recommended;
                return (
                  <tr key={g.name} className={recommended ? "recommended" : undefined}>
                    <td className="mono cb-file">
                      {g.label}
                      {recommended && (
                        <span className="badge ok">
                          <Star size={11} aria-hidden /> Recommended
                        </span>
                      )}
                    </td>
                    <td className="mono">{g.quant ?? "—"}</td>
                    <td>{formatBytes(g.size)}</td>
                    <td>
                      <FitCell fit={g.fit} />
                    </td>
                    <td>{g.fit ? (g.fit.max_context_vram ? formatTokens(g.fit.max_context_vram) : "—") : "—"}</td>
                    <td className="cb-actions">
                      {done ? (
                        <>
                          <span className="ok-text">
                            <Check size={13} aria-hidden /> Downloaded
                          </span>
                          {g.format === "gguf" && (
                            <button type="button" className="btn btn-small" onClick={() => onServe(g.name)}>
                              <Play size={12} aria-hidden /> Serve
                            </button>
                          )}
                        </>
                      ) : d && (d.state === "running" || d.state === "queued" || d.state === "paused") ? (
                        <span className="cb-inline-progress">
                          <Progress d={d} />
                          <span className="help">{Math.round((d.bytes_done / Math.max(d.bytes_total, 1)) * 100)}%</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => api.download(detail.repo_id, g.files)}
                          disabled={detail.gated && !detail.access}
                        >
                          <Download size={12} aria-hidden /> Download
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {detail.card && (
        <>
          <h3 className="cb-h3">Model card</h3>
          <div className="cb-card">
            <Markdown text={detail.card} />
          </div>
        </>
      )}
    </div>
  );
}

// -- downloads ----------------------------------------------------------------------------------------

function DownloadsTab({ api }: { api: CookbookApi }) {
  if (api.downloads.length === 0) {
    return <p className="pane-empty">No downloads. Find a model in the Models tab.</p>;
  }
  return (
    <ul className="cb-list">
      {api.downloads.map((d) => (
        <li key={d.id} className="cb-row">
          <div className="cb-row-main">
            <span className="cb-name">{d.repo_id}</span>
            <span className="mono help" title={d.files.join("\n")}>
              {d.files.length > 1 ? `${d.files[0]} and ${d.files.length - 1} more` : d.files[0]} · host {d.host}
            </span>
            <Progress d={d} />
            <span className="help">
              {formatBytes(d.bytes_done)} of {formatBytes(d.bytes_total)} ·{" "}
              {d.state === "running" ? "Downloading" : d.state === "done" ? "Complete" : d.state === "paused" ? "Paused" : d.state === "cancelled" ? "Cancelled" : d.state === "error" ? "Failed" : "Waiting"}
            </span>
            {d.error && <span className="field-error">{d.error}</span>}
          </div>
          <div className="cb-row-actions">
            {d.state === "running" && (
              <button type="button" className="btn btn-small" onClick={() => api.pause(d.id)}>
                <Pause size={12} aria-hidden /> Pause
              </button>
            )}
            {(d.state === "paused" || d.state === "error") && (
              <button type="button" className="btn btn-small" onClick={() => api.resume(d.id)}>
                <Play size={12} aria-hidden /> Continue
              </button>
            )}
            {(d.state === "running" || d.state === "paused" || d.state === "error" || d.state === "queued") && (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => api.cancel(d.id)}>
                <X size={12} aria-hidden /> Cancel
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// -- installed ----------------------------------------------------------------------------------------

function ServeForm({ file, onStart, onCancel }: { file: string; onStart: (context?: number, port?: number) => void; onCancel: () => void }) {
  const [context, setContext] = useState("");
  const [port, setPort] = useState("");
  return (
    <form
      className="cb-serve-form"
      onSubmit={(e) => {
        e.preventDefault();
        onStart(Number(context) || undefined, Number(port) || undefined);
      }}
    >
      <span className="help">
        Serve <span className="mono">{file}</span> with llama-server.
      </span>
      <label>
        Context
        <input className="mono" inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value.replace(/\D/g, ""))} placeholder="auto" />
      </label>
      <label>
        Port
        <input className="mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="auto" />
      </label>
      <button type="submit" className="btn btn-small btn-primary">
        <Play size={12} aria-hidden /> Start
      </button>
      <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** A Delete button with a second click to confirm. "id" is unique in the tab: one confirmation at a time. */
function DeleteButton({ id, confirm, setConfirm, size, what, onDelete }: {
  id: string;
  confirm: string | null;
  setConfirm: (id: string | null) => void;
  size: number;
  what: string; // For the screen reader: "the file tiny.gguf", "the Ollama model llama3.2:3b".
  onDelete: () => void;
}) {
  if (confirm !== id) {
    return (
      <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirm(id)} aria-label={`Delete ${what}`}>
        <Trash2 size={12} aria-hidden /> Delete
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn btn-small btn-danger" onClick={() => { setConfirm(null); onDelete(); }} aria-label={`Confirm: delete ${what}`}>
        <Trash2 size={12} aria-hidden /> Delete {formatBytes(size)}
      </button>
      <button type="button" className="icon-btn ghost" onClick={() => setConfirm(null)} aria-label={`Keep ${what}`} title="Keep">
        <X size={14} aria-hidden />
      </button>
    </>
  );
}

function InstalledTab({ api, serveTarget, setServeTarget }: {
  api: CookbookApi;
  serveTarget: { repo: string; file: string } | null;
  setServeTarget: (t: { repo: string; file: string } | null) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!api.installed) api.loadInstalled();
  }, [api.host]);
  const data = api.installed;
  const ollama = data && data !== "loading" ? data.ollama : undefined;
  const lmstudio = data && data !== "loading" ? data.lmstudio : undefined;
  return (
    <div>
      <div className="cb-tab-head">
        <span className="help">The models on the host {api.host}.</span>
        <button type="button" className="icon-btn ghost" onClick={api.loadInstalled} aria-label="Read the installed models again" title="Refresh">
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <ErrorBar text={api.errors["models.installed"] ?? api.errors["models.delete"]} onClose={() => { api.clearError("models.installed"); api.clearError("models.delete"); }} />
      <ErrorBar text={api.errors["serve.start"]} onClose={() => api.clearError("serve.start")} />
      {!data || data === "loading" ? (
        <p className="pane-empty">
          <LoaderCircle size={16} className="spin" aria-hidden /> Reading the models.
        </p>
      ) : (
        <>
          <section className="cb-source" aria-labelledby="src-hf">
            <h3 id="src-hf" className="cb-source-title">
              Cookbook downloads <span className="help mono">{data.cache}</span>
            </h3>
            {data.repos.length === 0 ? (
              <p className="help">No models are downloaded with the Cookbook on this host.</p>
            ) : (
              <ul className="cb-list">
                {data.repos.map((repo) => (
                  <li key={repo.repo_id} className="cb-repo">
                    <div className="cb-repo-head">
                      <HardDrive size={15} aria-hidden />
                      <span className="cb-name">{repo.repo_id}</span>
                      <span className="help">{formatBytes(repo.size)}</span>
                    </div>
                    <ul className="cb-files-list">
                      {groupInstalled(repo.files).map((g) => (
                        <li key={g.name}>
                          <div className="cb-file-row">
                            <span className="mono cb-file">{g.label}</span>
                            <span className="help">{formatBytes(g.size)}</span>
                            <span className="spacer" />
                            {g.name.endsWith(".gguf") && (
                              <button type="button" className="btn btn-small" onClick={() => setServeTarget({ repo: repo.repo_id, file: g.name })}>
                                <Play size={12} aria-hidden /> Serve
                              </button>
                            )}
                            <DeleteButton
                              id={`hf:${repo.repo_id}/${g.name}`}
                              confirm={confirm}
                              setConfirm={setConfirm}
                              size={g.size}
                              what={`the file ${g.label}`}
                              onDelete={() => api.deleteModel(repo.repo_id, g.files)}
                            />
                          </div>
                          {serveTarget?.repo === repo.repo_id && serveTarget.file === g.name && (
                            <ServeForm
                              file={g.name}
                              onCancel={() => setServeTarget(null)}
                              onStart={(context, port) => {
                                api.serve(repo.repo_id, g.name, context, port);
                                setServeTarget(null);
                              }}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {ollama && (
            <section className="cb-source" aria-labelledby="src-ollama">
              <h3 id="src-ollama" className="cb-source-title">
                Ollama <span className="help mono">{ollama.url}</span>
              </h3>
              {!ollama.running ? (
                <p className="help">
                  {ollama.installed
                    ? "Ollama is installed, but its server does not answer. Start Ollama to see its models."
                    : "Ollama is not installed on this host, or its server does not run."}
                </p>
              ) : ollama.models.length === 0 ? (
                <p className="help">Ollama has no models on this host.</p>
              ) : (
                <ul className="cb-files-list">
                  {ollama.models.map((m) => (
                    <li key={m.name}>
                      <div className="cb-file-row">
                        <span className="mono cb-file">{m.name}</span>
                        <span className="help">{[m.parameters, m.quantization, formatBytes(m.size)].filter(Boolean).join(" · ")}</span>
                        <span className="spacer" />
                        <DeleteButton
                          id={`ollama:${m.name}`}
                          confirm={confirm}
                          setConfirm={setConfirm}
                          size={m.size}
                          what={`the Ollama model ${m.name}`}
                          onDelete={() => api.deleteOther("ollama", m.name)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {lmstudio && (
            <section className="cb-source" aria-labelledby="src-lmstudio">
              <h3 id="src-lmstudio" className="cb-source-title">
                LM Studio {lmstudio.folder && <span className="help mono">{lmstudio.folder}</span>}
              </h3>
              {!lmstudio.folder ? (
                <p className="help">LM Studio has no models folder on this host.</p>
              ) : lmstudio.models.length === 0 ? (
                <p className="help">LM Studio has no models on this host.</p>
              ) : (
                <>
                  <ul className="cb-files-list">
                    {lmstudio.models.map((m) => (
                      <li key={m.id}>
                        <div className="cb-file-row">
                          <span className="mono cb-file" title={m.files.map((f) => f.name).join("\n")}>
                            {m.id}
                          </span>
                          <span className="help">
                            {m.files.length === 1 ? "1 file" : `${m.files.length} files`} · {formatBytes(m.size)}
                          </span>
                          <span className="spacer" />
                          <DeleteButton
                            id={`lmstudio:${m.id}`}
                            confirm={confirm}
                            setConfirm={setConfirm}
                            size={m.size}
                            what={`the LM Studio model ${m.id}`}
                            onDelete={() => api.deleteOther("lmstudio", m.id)}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="help">Delete removes the model folder. If LM Studio has the model loaded, eject it first.</p>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// -- served models ----------------------------------------------------------------------------------------

function ServedTab({ api, hasSession, onUseModel }: { api: CookbookApi; hasSession: boolean; onUseModel: (model: string) => void }) {
  const [logFor, setLogFor] = useState<string | null>(null);
  useEffect(() => {
    api.loadServes();
  }, [api.host]);
  useEffect(() => {
    if (!logFor) return;
    api.loadOutput(logFor);
    const timer = window.setInterval(() => api.loadOutput(logFor), 2000);
    return () => window.clearInterval(timer);
  }, [logFor, api.host]);

  return (
    <div>
      <ErrorBar text={api.errors["serve.start"] ?? api.errors["serve.stop"] ?? api.errors["serve.list"]} onClose={() => ["serve.start", "serve.stop", "serve.list"].forEach(api.clearError)} />
      {api.serves.length === 0 ? (
        <p className="pane-empty">No model is served on this host. Serve a downloaded model from the Installed tab.</p>
      ) : (
        <ul className="cb-list">
          {api.serves.map((s: ServeItem) => (
            <li key={s.name} className="cb-row cb-serve">
              <div className="cb-row-main">
                <span className="cb-name">
                  <Server size={14} aria-hidden /> {s.name}
                  <span className={`server-state state-${s.state === "running" ? "running" : s.state === "crashed" ? "crashed" : "starting"}`}>
                    {s.state === "starting" && <LoaderCircle size={12} className="spin" aria-hidden />}
                    {s.state === "running" ? "Running" : s.state === "crashed" ? "Stopped with an error" : "Loading the model"}
                  </span>
                </span>
                <span className="help mono">
                  127.0.0.1:{s.port} · {formatTokens(s.context)} context · {s.gpu_layers} GPU layers
                </span>
                <span className="help">
                  Provider <span className="mono">{s.provider}</span>, model <span className="mono">{s.alias}</span>
                </span>
              </div>
              <div className="cb-row-actions">
                {s.state === "running" && (
                  <button type="button" className="btn btn-small btn-primary" onClick={() => onUseModel(`${s.provider}/${s.alias}`)}>
                    {hasSession ? "Use in the session" : "Use for a session"}
                  </button>
                )}
                <button type="button" className="btn btn-small" onClick={() => setLogFor(logFor === s.name ? null : s.name)} aria-pressed={logFor === s.name}>
                  <ScrollText size={12} aria-hidden /> Log
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => api.stopServe(s.name)}>
                  <Square size={12} aria-hidden /> Stop
                </button>
              </div>
              {logFor === s.name && (
                <pre className="server-log cb-log" aria-label={`Log of ${s.name}`}>
                  {api.output?.name === s.name ? api.output.text || "No output yet." : "Loading the log."}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="help">
        A served model continues after the app closes. It runs in tmux when the host has tmux. The Cookbook adds it to the providers when it is ready.
      </p>
    </div>
  );
}

// -- hosts and settings --------------------------------------------------------------------------------------

function HostsTab({ api, tokenSaved, onSaveToken }: { api: CookbookApi; tokenSaved: boolean; onSaveToken: (token: string | null) => void }) {
  const [editing, setEditing] = useState<{ previous?: string; name: string; ssh: string; python: string; llama_server: string } | null>(null);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  return (
    <div className="cb-hosts">
      <section aria-labelledby="cb-hosts-title">
        <div className="list-head">
          <h3 id="cb-hosts-title" className="cb-h3">Hosts</h3>
          <button type="button" className="btn btn-small" onClick={() => setEditing({ name: "", ssh: "", python: "python3", llama_server: "" })}>
            <Plus size={13} aria-hidden /> Add a remote host
          </button>
        </div>
        <ErrorBar text={api.errors["cookbook.host.save"] ?? api.errors["cookbook.host.delete"]} onClose={() => { api.clearError("cookbook.host.save"); api.clearError("cookbook.host.delete"); }} />
        <ul className="cb-list">
          {api.hosts.map((h) => (
            <li key={h.name} className="cb-row">
              <div className="cb-row-main">
                <span className="cb-name">{h.label}</span>
                <span className="help mono">llama-server: {h.llama_server || "llama-server on the PATH"}</span>
              </div>
              <div className="cb-row-actions">
                <button
                  type="button"
                  className="icon-btn ghost"
                  aria-label={`Edit ${h.name}`}
                  title="Edit"
                  onClick={() => setEditing({ previous: h.name, name: h.name, ssh: h.ssh ?? "", python: h.python, llama_server: h.llama_server ?? "" })}
                >
                  <Pencil size={14} aria-hidden />
                </button>
                {h.remote && (
                  <button type="button" className="icon-btn ghost" aria-label={`Delete ${h.name}`} title="Delete" onClick={() => api.deleteHost(h.name)}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <form
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              api.saveHost({
                name: editing.name.trim(),
                ssh: editing.previous === "local" ? undefined : editing.ssh.trim(),
                python: editing.python.trim(),
                llama_server: editing.llama_server.trim(),
                previous: editing.previous,
              });
              setEditing(null);
            }}
          >
            <h4 className="form-title">{editing.previous ? `Edit ${editing.previous}` : "Add a remote host"}</h4>
            {editing.previous !== "local" && (
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="cb-host-name">Name</label>
                  <input id="cb-host-name" className="mono" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="gpu-box" />
                </div>
                <div className="field">
                  <label htmlFor="cb-host-python">Python</label>
                  <input id="cb-host-python" className="mono" value={editing.python} onChange={(e) => setEditing({ ...editing, python: e.target.value })} placeholder="python3" />
                </div>
              </div>
            )}
            {editing.previous !== "local" && (
              <div className="field">
                <label htmlFor="cb-host-ssh">SSH address</label>
                <input id="cb-host-ssh" className="mono" value={editing.ssh} onChange={(e) => setEditing({ ...editing, ssh: e.target.value })} placeholder="drew@gpu-box or drew@gpu-box:2222" />
              </div>
            )}
            <div className="field">
              <label htmlFor="cb-host-llama">llama-server command</label>
              <input id="cb-host-llama" className="mono" value={editing.llama_server} onChange={(e) => setEditing({ ...editing, llama_server: e.target.value })} placeholder="llama-server (on the PATH)" />
              <p className="help">A path, for example ~/llama.cpp/build/bin/llama-server. The host needs Python 3 and huggingface_hub for downloads.</p>
            </div>
            <div className="form-actions">
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Save
              </button>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="cb-key-title">
        <h3 id="cb-key-title" className="cb-h3">
          <KeyRound size={15} aria-hidden /> SSH key
        </h3>
        {api.publicKey ? (
          <>
            <p className="help">
              Add this public key to <code>~/.ssh/authorized_keys</code> on each remote host. The private key is in{" "}
              <code>{api.keyPath}</code> on the daemon computer.
            </p>
            <div className="cb-key">
              <code className="mono">{api.publicKey}</code>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  void navigator.clipboard.writeText(api.publicKey ?? "").then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="help">The daemon makes an SSH key in <code>~/.harness/ssh/</code> for the remote hosts.</p>
            <button type="button" className="btn" onClick={api.createKey}>
              <KeyRound size={14} aria-hidden /> Create the SSH key
            </button>
          </>
        )}
        <ErrorBar text={api.errors["cookbook.ssh_key"]} />
      </section>

      <section aria-labelledby="cb-token-title">
        <h3 id="cb-token-title" className="cb-h3">Hugging Face token</h3>
        <p className="help">
          Gated models, such as some Llama and Gemma models, need a token. {isTauri() ? "The app keeps it in the keychain of this computer." : "Without the desktop app, the token is kept only until this tab closes."}{" "}
          The daemon keeps it in memory only.
        </p>
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) {
              onSaveToken(token.trim());
              setToken("");
            }
          }}
        >
          <label htmlFor="cb-token" className="sr-only">
            Hugging Face token
          </label>
          <input id="cb-token" className="mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tokenSaved ? "A token is saved. Enter a new one to replace it." : "hf_..."} />
          <button type="submit" className="btn btn-primary" disabled={!token.trim()}>
            Save
          </button>
          {tokenSaved && (
            <button type="button" className="btn btn-ghost" onClick={() => onSaveToken(null)}>
              Remove
            </button>
          )}
        </form>
        {tokenSaved && (
          <p className="ok-text">
            <Check size={13} aria-hidden /> A token is saved.
          </p>
        )}
      </section>
    </div>
  );
}

// -- the screen ---------------------------------------------------------------------------------------------

export function CookbookScreen({
  api,
  hasSession,
  tokenSaved,
  onSaveToken,
  onUseModel,
  onReturn,
}: {
  api: CookbookApi;
  hasSession: boolean;
  tokenSaved: boolean;
  onSaveToken: (token: string | null) => void;
  onUseModel: (model: string) => void;
  onReturn: () => void;
}) {
  const [tab, setTabState] = useState<Tab>(() => (loadPref("cookbookTab", "models") as Tab) || "models");
  const [serveTarget, setServeTarget] = useState<{ repo: string; file: string } | null>(null);
  const setTab = (t: Tab) => {
    setTabState(t);
    savePref("cookbookTab", t);
  };
  const running = api.downloads.filter((d) => d.state === "running").length;
  const hostNames = useMemo(() => api.hosts.map((h) => h.name), [api.hosts]);

  // A served model that is ready: show it.
  useEffect(() => {
    if (api.ready) setTab("served");
  }, [api.ready?.key]);

  return (
    <div className="start-screen cookbook-screen">
      <section className="panel cookbook" aria-labelledby="cookbook-title">
        <div className="panel-head">
          <h1 id="cookbook-title">
            <ChefHat size={20} aria-hidden /> Cookbook
          </h1>
          <label className="cb-host-select">
            Host
            <select value={api.host} onChange={(e) => api.setHost(e.target.value)}>
              {(hostNames.length ? hostNames : ["local"]).map((n) => (
                <option key={n} value={n}>
                  {n === "local" ? "This computer (daemon)" : n}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onReturn}>
            {hasSession ? "Back to the session" : "Back"}
          </button>
        </div>
        <HardwareBar api={api} />
        <div className="cb-tabs" role="tablist" aria-label="Cookbook">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "downloads" && running > 0 && <span className="tab-badge running">{running}</span>}
              {t.id === "served" && api.serves.length > 0 && <span className="tab-badge">{api.serves.length}</span>}
            </button>
          ))}
        </div>
        <div className="cb-body" role="tabpanel">
          {tab === "models" &&
            (api.detail === "loading" ? (
              <p className="pane-empty">
                <LoaderCircle size={16} className="spin" aria-hidden /> Loading the model details and the fit results.
              </p>
            ) : api.detail ? (
              <DetailView
                api={api}
                detail={api.detail}
                onServe={(file) => {
                  setServeTarget({ repo: (api.detail as HfDetail).repo_id, file });
                  setTab("installed");
                }}
              />
            ) : (
              <>
                <ErrorBar text={api.errors["hf.model"]} onClose={() => api.clearError("hf.model")} />
                <SearchView api={api} />
              </>
            ))}
          {tab === "downloads" && <DownloadsTab api={api} />}
          {tab === "installed" && <InstalledTab api={api} serveTarget={serveTarget} setServeTarget={setServeTarget} />}
          {tab === "served" && <ServedTab api={api} hasSession={hasSession} onUseModel={onUseModel} />}
          {tab === "hosts" && <HostsTab api={api} tokenSaved={tokenSaved} onSaveToken={onSaveToken} />}
        </div>
      </section>
    </div>
  );
}
