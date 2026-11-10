// One formula for file sizes (audit C13), as Claude shows them: powers of 1000, one decimal, no ".0".

/** "512 B", "95.3 MB", "1 GB". No size or 0: "0 B". */
export function formatBytes(bytes: number | null | undefined): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes ?? 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}
