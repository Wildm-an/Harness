// The language of the open file, in the editor status bar. The editor picks it from the file
// extension. A click opens a list of the Monaco languages, with a filter, to choose another one.
// The choice changes the colors and the editor features only: the file on disk does not change.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export interface LanguageItem {
  id: string;
  name: string;
}

/** The languages for the menu: one name each, sorted by name, plain text first. */
export function languageItems(languages: { id: string; aliases?: string[] }[]): LanguageItem[] {
  const items = languages.map((l) => ({ id: l.id, name: l.aliases?.[0] ?? l.id }));
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  return unique.sort((a, b) => (a.id === "plaintext" ? -1 : b.id === "plaintext" ? 1 : a.name.localeCompare(b.name)));
}

/** The items whose name or id has the query, with no case. */
export function filterLanguages(items: LanguageItem[], query: string): LanguageItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)) : items;
}

export function LanguageMenu({
  value,
  languages,
  disabled,
  onChoose,
}: {
  value: string; // The language id now.
  languages: LanguageItem[];
  disabled?: boolean;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  const shown = useMemo(() => filterLanguages(languages, query), [languages, query]);
  const name = languages.find((l) => l.id === value)?.name ?? value;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const choose = (id: string) => {
    onChoose(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="language-menu" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Language of the file"
      >
        {name}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          className="menu language-dropdown"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            autoFocus
            className="language-filter"
            value={query}
            placeholder="Select a language"
            aria-label="Filter the languages"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault();
                choose(shown[0].id);
              }
            }}
          />
          <ul className="language-list" role="listbox" aria-label="Languages">
            {shown.map((l) => (
              <li key={l.id}>
                <button type="button" role="option" aria-selected={l.id === value} onClick={() => choose(l.id)}>
                  <span className="menu-check">{l.id === value && <Check size={13} aria-hidden />}</span>
                  <span>{l.name}</span>
                  <span className="language-id mono">{l.id}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="menu-note">No language matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
