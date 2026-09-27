import { memo, useMemo, useState } from "react";
import { CaseSensitive, LoaderCircle, Regex, Search } from "lucide-react";
import type { SearchState } from "./useEditor";

/** Search across the project. The daemon runs ripgrep, or its Python search. */
export const SearchPanel = memo(function SearchPanel({
  search,
  onSearch,
  onOpen,
}: {
  search: SearchState;
  onSearch: (query: string, options: { regex: boolean; case: boolean; glob: string }) => void;
  onOpen: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState(search.query);
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [glob, setGlob] = useState("");

  const grouped = useMemo(() => {
    const map = new Map<string, SearchState["items"]>();
    for (const item of search.items) {
      const list = map.get(item.path) ?? [];
      list.push(item);
      map.set(item.path, list);
    }
    return [...map.entries()];
  }, [search.items]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query, { regex, case: matchCase, glob });
  };

  return (
    <div className="search-panel">
      <form onSubmit={submit} className="search-form">
        <div className="search-input">
          <Search size={14} aria-hidden />
          <label htmlFor="project-search" className="sr-only">
            Search in the project
          </label>
          <input
            id="project-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            spellCheck={false}
          />
          <button
            type="button"
            className={`toggle${matchCase ? " on" : ""}`}
            aria-pressed={matchCase}
            onClick={() => setMatchCase((v) => !v)}
            title="Match case"
            aria-label="Match case"
          >
            <CaseSensitive size={15} aria-hidden />
          </button>
          <button
            type="button"
            className={`toggle${regex ? " on" : ""}`}
            aria-pressed={regex}
            onClick={() => setRegex((v) => !v)}
            title="Regular expression"
            aria-label="Regular expression"
          >
            <Regex size={15} aria-hidden />
          </button>
        </div>
        <label htmlFor="search-glob" className="sr-only">
          Files to search
        </label>
        <div className="search-row">
          <input
            id="search-glob"
            className="mono search-glob"
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            placeholder="Files, for example *.py"
            spellCheck={false}
          />
          {/* A form with two text fields submits on Enter only if it has a submit button. */}
          <button type="submit" className="btn btn-small" disabled={!query.trim() || search.busy}>
            Search
          </button>
        </div>
      </form>
      <div className="search-results" aria-live="polite">
        {search.busy && (
          <p className="search-note">
            <LoaderCircle size={13} className="spin" aria-hidden /> Searching
          </p>
        )}
        {search.error && <p className="field-error">{search.error}</p>}
        {!search.busy && !search.error && search.query && (
          <p className="search-note">
            {search.items.length === 0
              ? "No results."
              : `${search.items.length}${search.truncated ? "+" : ""} results in ${grouped.length} files`}
          </p>
        )}
        {grouped.map(([path, items]) => (
          <div key={path} className="search-file">
            <div className="search-path mono" title={path}>
              {path}
            </div>
            <ul>
              {items.map((item) => (
                <li key={`${item.line}`}>
                  <button type="button" className="search-hit" onClick={() => onOpen(item.path, item.line)}>
                    <span className="search-line mono">{item.line}</span>
                    <span className="search-text mono">{item.text.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
});
