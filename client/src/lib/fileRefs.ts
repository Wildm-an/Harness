// "Add files or photos" (Ctrl+U in the prompt box, docs/UI_RULES.md 5.2): the user picks files, and
// the prompt gets a reference for each one. A file in the project becomes "@path": the daemon adds
// its text to the prompt. The daemon reads no file outside the project, so such a file (or a path
// with a space, which ends an "@" reference) goes in as its full path in quotes. The agent can
// then read it with its tools.

export const ADD_FILES_SHORTCUT = "Ctrl+U";

/** Ctrl+U (Cmd+U on macOS), with no other modifier. */
export function isAddFilesShortcut(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  if (e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return false;
  return e.code === "KeyU" || e.key.toLowerCase() === "u";
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const windowsPath = (p: string) => /^[a-zA-Z]:\//.test(p);

/** The path of ``file`` in ``root``, with "/" separators, or null if it is not in ``root``. */
export function pathInProject(file: string, root: string): string | null {
  const f = slashes(file);
  const r = slashes(root);
  if (!r) return null;
  const caseless = windowsPath(f) || windowsPath(r);
  const [fk, rk] = caseless ? [f.toLowerCase(), r.toLowerCase()] : [f, r];
  if (!fk.startsWith(`${rk}/`)) return null;
  return f.slice(r.length + 1);
}

/** The text to add to the prompt for the picked files. */
export function filesPromptText(files: string[], cwd: string): string {
  return files
    .map((file) => {
      const inProject = pathInProject(file, cwd);
      if (inProject && !/\s/.test(inProject)) return `@${inProject}`;
      return `"${file.replace(/"/g, "")}"`;
    })
    .join(" ");
}
