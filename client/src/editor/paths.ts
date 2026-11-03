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

/**
 * Why "Open folder…" cannot change the folder of the session now, or null when it can. The texts
 * match the folder chip of the title bar.
 */
export function openFolderBlocked(state: { connected: boolean; running: boolean; worktree: boolean }): string | null {
  if (!state.connected) return "Connect to a computer to change the folder.";
  if (state.worktree) return "This session runs in an isolated worktree, so its folder can't be changed.";
  if (state.running) return "Wait for the end of the turn to change the folder.";
  return null;
}

// Files that the code editor cannot open: images, media, archives, programs, fonts, documents,
// and databases. The file tree shows them grayed out.
const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico webp avif tif tiff psd heic " +
    "mp3 wav ogg flac m4a aac mp4 m4v mov avi mkv webm wmv " +
    "zip gz tgz bz2 xz 7z rar tar zst jar war apk ipa dmg iso msi cab " +
    "exe dll so dylib lib a o obj pdb class pyc pyo wasm node bin dat " +
    "ttf otf woff woff2 eot " +
    "pdf doc docx xls xlsx ppt pptx odt ods odp " +
    "sqlite sqlite3 db mdb accdb parquet feather npy npz pkl pickle h5 onnx pt pth safetensors"
  ).split(" "),
);

/** False for a file that the code editor cannot open (a binary file), by its extension. */
export function isEditableFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true; // No extension, or a dot file such as .gitignore: text.
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Why a name for New file or New folder cannot work, or null when it can. The name is a path in
 * the project, for example "src/utils/helpers.py". The daemon checks it again.
 */
export function newEntryProblem(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, "/");
  if (!path || path === "/") return "Type a name.";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..")) {
    return "Use a path in the project, for example src/app.py.";
  }
  if (/[<>:"|?*]/.test(path)) return 'A name cannot have < > : " | ? *';
  return null;
}

/** The folder of the active file with a "/" at the end, as the start of a new name. "" for the project folder. */
export function newEntryStart(activePath: string | null): string {
  const at = activePath ? activePath.lastIndexOf("/") : -1;
  return at > 0 ? `${activePath!.slice(0, at)}/` : "";
}
