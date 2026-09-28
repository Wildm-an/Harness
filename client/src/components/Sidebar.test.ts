import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../daemon/protocol";
import { folderName, groupSessions } from "./Sidebar";

const NOW = new Date(2026, 8, 28, 15, 0, 0);
const at = (days: number, hour = 12) => new Date(2026, 8, 28 - days, hour).getTime() / 1000;
const session = (id: string, updated: number): SessionSummary => ({
  id, cwd: "C:\\work\\app", provider: "demo", model: "scripted", title: id, created_at: updated, updated_at: updated,
});

describe("the sidebar session list", () => {
  it("groups the sessions by day, newest first", () => {
    const groups = groupSessions([session("old", at(30)), session("today-early", at(0, 1)), session("week", at(4)),
      session("yesterday", at(1)), session("today-late", at(0, 14))], NOW);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["today-late", "today-early"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Older", ["old"]],
    ]);
  });

  it("leaves out the empty groups", () => {
    expect(groupSessions([session("a", at(0))], NOW).map((g) => g.label)).toEqual(["Today"]);
    expect(groupSessions([], NOW)).toEqual([]);
  });

  it("shows the last folder of a path", () => {
    expect(folderName("C:\\work\\app")).toBe("app");
    expect(folderName("/home/me/app/")).toBe("app");
  });
});
