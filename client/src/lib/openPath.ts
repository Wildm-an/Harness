// "Go to a line from a path in the chat" (SPEC.md section 8.5). The chat components call
// this context. The app opens the file in the editor pane.

import { createContext, useContext } from "react";

export type OpenPath = (path: string, line?: number) => void;

export const OpenPathContext = createContext<OpenPath | null>(null);

export function useOpenPath(): OpenPath | null {
  return useContext(OpenPathContext);
}

// "src/app.py", "./src/app.py:42", or "src/app.py:10-25". A path needs a file extension,
// so that a word such as "v1.2" or "e.g." is not a link.
const PATH_RE = /^(?:\.\/)?((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?:-\d+)?)?$/;

export function parsePathRef(text: string): { path: string; line?: number } | null {
  const m = PATH_RE.exec(text.trim());
  if (!m) return null;
  if (/^\d+(\.\d+)+$/.test(m[1])) return null; // A version number.
  if (/^https?:/i.test(text)) return null;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined };
}
