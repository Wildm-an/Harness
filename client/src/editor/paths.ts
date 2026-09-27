// Pure path helpers of the editor. They have no Monaco import, so the unit tests can load them.

/** A path from the chat: relative to the project, with "/" as the separator. */
export function normalizePath(raw: string, cwd: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, "");
}

export interface LineSelection {
  startLineNumber: number;
  endLineNumber: number;
  endColumn: number;
}

/** "@src/app.py:10-25" for the selection, or "@src/app.py:10" for one line. */
export function selectionReference(path: string, selection: LineSelection): string {
  let end = selection.endLineNumber;
  // A selection that ends at the start of a line does not include that line.
  if (selection.endColumn === 1 && end > selection.startLineNumber) end -= 1;
  const start = selection.startLineNumber;
  return start === end ? `@${path}:${start}` : `@${path}:${start}-${end}`;
}
