import { describe, expect, it } from "vitest";
import type { DiskUsage } from "../daemon/protocol";
import { categories, checkedAgo, formatBytes } from "./StorageDialog";

describe("the Storage dialog", () => {
  it("shows sizes as Claude does", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(95_300_000)).toBe("95.3 MB");
    expect(formatBytes(1_000_000_000)).toBe("1 GB");
    expect(formatBytes(13_640_000_000)).toBe("13.6 GB");
  });

  it("tells when it checked", () => {
    expect(checkedAgo(0, 30_000)).toBe("just now");
    expect(checkedAgo(0, 60_000)).toBe("1 minute ago");
    expect(checkedAgo(0, 3 * 3_600_000)).toBe("3 hours ago");
  });

  it("puts the app folders in Runtime and in the caches", () => {
    const usage: DiskUsage = {
      checked_at: 0,
      home: "/h",
      sessions: { size: 10, database: 10, count: 7, stale_count: 6, stale_size: 88_200_000, worktrees: [], largest: [] },
      models: { size: 0, path: "/hf", items: [] },
      runtime: { size: 100, path: "/pw", items: [{ name: "chromium-1", size: 100 }] },
      memory: { size: 5, items: [] },
      caches: { size: 20, items: [{ name: "logs", size: 20 }] },
    };
    const list = categories(usage, [
      { id: "app", path: "/app", size: 1000 },
      { id: "webview", path: "/w", size: 300 },
    ]);
    expect(list.map((c) => c.id)).toEqual(["sessions", "models", "runtime", "memory", "caches"]);
    expect(list[0].summary).toBe("7 sessions and 0 worktrees. 6 have had no activity in the last 30 days (88.2 MB).");
    expect(list[1].summary).toBe("No model files in the Hugging Face cache.");
    expect(list[2].size).toBe(1100);
    expect(list[4].size).toBe(320);
    expect(list[4].items.map((i) => i.name)).toEqual(["Web cache and app settings", "Logs"]);
  });
});
