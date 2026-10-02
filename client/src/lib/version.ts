// Version numbers of the app and the daemon, for example "0.1.29".

/** -1 if a is older than b, 1 if a is newer, 0 if they are the same. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, "").split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.trim().replace(/^v/i, "").split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
