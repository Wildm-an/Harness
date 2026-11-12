import { describe, expect, it } from "vitest";
import { changelogSections, checkedText, updateHero } from "./UpdatesPage";
import type { UpdateState } from "../lib/updater";

const now = new Date(2026, 10, 12, 15, 0).getTime();
const at = new Date(2026, 10, 12, 9, 41).getTime();
const hero = (state: UpdateState, checked: number | null = at) => updateHero(state, "0.1.77", checked, true, now);

describe("the Updates page", () => {
  it("names the day of the last check", () => {
    expect(checkedText(at, now)).toMatch(/^Today, /);
    expect(checkedText(at - 24 * 60 * 60 * 1000, now)).toMatch(/^Yesterday, /);
    expect(checkedText(new Date(2026, 10, 1, 9, 41).getTime(), now)).not.toMatch(/^(Today|Yesterday)/);
  });

  it("shows up to date with the time of the last check", () => {
    const h = hero({ kind: "none" });
    expect([h.badge, h.title, h.action?.label]).toEqual(["ok", "Harness is up to date", "Check for updates"]);
    expect(h.detail).toMatch(/^Last checked: Today, /);
    expect(h.version).toBe("Current version: 0.1.77");
  });

  it("offers the install of a new version", () => {
    const h = hero({ kind: "available", update: { version: "0.1.78" } } as UpdateState);
    expect([h.badge, h.title, h.action?.kind, h.action?.label]).toEqual(["pending", "Harness 0.1.78 is available", "install", "Install and restart"]);
    expect(h.version).toBe("Current version: 0.1.77");
  });

  it("shows the download progress, then the install", () => {
    const download = hero({ kind: "installing", version: "0.1.78", step: "download", percent: 40 });
    expect([download.title, download.detail, download.percent, download.busy, download.action]).toEqual(["Downloading Harness 0.1.78", "40%", 40, true, null]);
    const install = hero({ kind: "installing", version: "0.1.78", step: "install", percent: 100 });
    expect([install.title, install.percent]).toEqual(["Installing Harness 0.1.78", null]);
  });

  it("shows an error with the reason and a new try", () => {
    const failed = hero({ kind: "error", message: "The update check failed: offline" });
    expect([failed.badge, failed.title, failed.detail, failed.action?.label]).toEqual(["error", "The update check failed", "offline", "Try again"]);
    const install = hero({ kind: "error", message: "The update did not install: network down" });
    expect([install.title, install.detail]).toEqual(["The update did not install", "network down"]);
  });

  it("says when no check ran yet, and has no action outside the desktop app", () => {
    expect(hero({ kind: "idle" }, null).detail).toBe("Harness did not check for updates yet.");
    const web = updateHero({ kind: "idle" }, "0.1.77", null, false, now);
    expect(web.action).toBeNull();
    expect(web.version).toBe("Current version: 0.1.77");
    expect(updateHero({ kind: "none" }, null, at, true, now).version).toBeNull();
  });
});

describe("the changelog", () => {
  it("splits the file into one section for each version, from the first heading", () => {
    const text = "# Changelog\n\nIntro text.\n\n## 0.1.3 (2026-11-12)\n\n- C\n\n## 0.1.2\n\n### Group\n\n- B\n\n## 0.1.1\n\n- A\n";
    expect(changelogSections(text)).toEqual(["## 0.1.3 (2026-11-12)\n\n- C", "## 0.1.2\n\n### Group\n\n- B", "## 0.1.1\n\n- A"]);
  });

  it("keeps a file with no version heading as one section", () => {
    expect(changelogSections("No versions yet.")).toEqual(["No versions yet."]);
  });
});
