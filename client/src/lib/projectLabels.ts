// Projects with the same name, for example two "app" folders, get their parent folder after the
// name, as in VS Code: "app · work" and "app · other". If the parent folders also have the same
// name, the label uses more parent folders until the labels are different.

/** The folder names of a path, without the drive or the root. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s && !/^[a-z]:$/i.test(s));
}

/** Case-insensitive, because Windows paths have no case. */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * For each item whose name is the same as the name of another item: the parent folders that make
 * it different, for example "work" or "client/work". Items with a unique name are not in the map.
 */
export function parentHints<T extends { key: string; name: string; path: string }>(items: T[]): Map<string, string> {
  const hints = new Map<string, string>();
  const byName = new Map<string, T[]>();
  for (const item of items) {
    const name = item.name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const parents = group.map((item) => segments(item.path).slice(0, -1)); // Without the folder itself.
    const depth = Math.max(...parents.map((p) => p.length));
    for (let n = 1; n <= Math.max(depth, 1); n++) {
      const tails = parents.map((p) => p.slice(-n).join("/"));
      const unique = tails.every((t, i) => tails.every((u, j) => i === j || !same(t, u)));
      if (unique || n >= depth) {
        group.forEach((item, i) => hints.set(item.key, tails[i] || item.path));
        break;
      }
    }
  }
  return hints;
}
