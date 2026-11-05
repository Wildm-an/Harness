import { describe, expect, it } from "vitest";
import type { TaskItem } from "../daemon/protocol";
import { RAIL_SECTIONS, contextShare, foldedValue, moveSection, parseOrder, stepSection, type RailSection, needsRailRoom, parseFolded, percentText, prStateText, railAfterPanes, railShown, railTasks, sortTasks, taskDetailText, taskSummary, toggleFolded } from "./sessionRail";

const task = (id: string, status: TaskItem["status"], started_at: number): TaskItem => ({
  id,
  command: `cmd ${id}`,
  description: "",
  status,
  started_at,
  ended_at: null,
  returncode: null,
});

describe("the session rail sections", () => {
  it("use the order of Claude", () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(["environment", "context", "pullRequests", "servers", "browser", "backgroundTasks"]);
  });

  it("read the folded sections and drop unknown ids", () => {
    expect(parseFolded('["context","nope","environment","settings"]')).toEqual(["environment", "context"]);
    expect(parseFolded("not json")).toEqual([]);
    expect(parseFolded('{"a":1}')).toEqual([]);
  });

  it("fold and open a section", () => {
    const folded = toggleFolded([], "context");
    expect(folded).toEqual(["context"]);
    expect(toggleFolded(folded, "context")).toEqual([]);
  });

  it("show the rail when no preference is saved", () => {
    expect(railShown()).toBe(true);
  });
});

describe("the context section", () => {
  it("keeps the share between 0 and 1", () => {
    expect(contextShare(50, 200)).toBe(0.25);
    expect(contextShare(500, 200)).toBe(1);
    expect(contextShare(10, 0)).toBe(0);
  });

  it("writes a small share as <1%", () => {
    expect(percentText(0)).toBe("0%");
    expect(percentText(0.004)).toBe("<1%");
    expect(percentText(0.456)).toBe("46%");
  });
});

describe("the pull request and task sections", () => {
  it("name the pull request state", () => {
    expect(prStateText("draft")).toBe("Draft");
    expect(prStateText("merged")).toBe("Merged");
  });

  it("put the running tasks first, then the newest", () => {
    const sorted = sortTasks([task("a", "done", 3), task("b", "running", 1), task("c", "failed", 5)]);
    expect(sorted.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("count the running and the ended tasks", () => {
    expect(taskSummary([])).toBe("None");
    expect(taskSummary([task("a", "running", 1), task("b", "done", 2), task("c", "stopped", 3)])).toBe("1 running · 2 ended");
  });
});

describe("the heading of a folded section", () => {
  it("shows the share of the context window for the Context section", () => {
    expect(foldedValue("context", { tokens: 5700, length: 10000 })).toBe("57%");
    expect(foldedValue("context", { tokens: 10, length: 10000 })).toBe("<1%");
  });

  it("shows no value without context data or for another section", () => {
    expect(foldedValue("context", null)).toBeNull();
    expect(foldedValue("servers", { tokens: 5700, length: 10000 })).toBeNull();
  });
});

describe("the room for a pane", () => {
  it("closes the rail when any pane opens", () => {
    expect(needsRailRoom([], ["preview"])).toBe(true);
    expect(needsRailRoom(["preview"], ["preview", "browser"])).toBe(true);
    expect(needsRailRoom([], ["files"])).toBe(true);
    expect(needsRailRoom([], ["terminal", "diff"])).toBe(true);
  });

  it("keeps the rail when no new pane opens", () => {
    expect(needsRailRoom(["browser"], ["browser"])).toBe(false);
    expect(needsRailRoom(["preview"], [])).toBe(false);
  });

  it("opens the rail again when the last pane closes, if a pane closed it", () => {
    let state = railAfterPanes({ open: true, auto: false }, [], ["files"]);
    expect(state).toEqual({ open: false, auto: true });
    state = railAfterPanes(state, ["files"], ["files", "diff"]);
    expect(state).toEqual({ open: false, auto: true });
    state = railAfterPanes(state, ["files", "diff"], ["diff"]);
    expect(state.open).toBe(false); // One pane is still open.
    state = railAfterPanes(state, ["diff"], []);
    expect(state).toEqual({ open: true, auto: false });
  });

  it("keeps a rail closed that the user closed", () => {
    expect(railAfterPanes({ open: false, auto: false }, ["files"], [])).toEqual({ open: false, auto: false });
  });
});

describe("the background tasks of the rail", () => {
  it("shows all the running tasks, then three ended tasks", () => {
    const list = [
      ...["r1", "r2", "r3", "r4", "r5"].map((id, i) => task(id, "running", i)),
      ...["e1", "e2", "e3", "e4"].map((id, i) => task(id, "done", 10 + i)),
    ];
    expect(railTasks(list).map((t) => t.id)).toEqual(["r5", "r4", "r3", "r2", "r1", "e4", "e3", "e2"]);
  });

  it("names the kind of each task, and counts down a wakeup", () => {
    expect(taskDetailText(task("a", "running", 1), 0)).toBe("Command · Running");
    expect(taskDetailText({ ...task("b", "done", 1), kind: "agent" }, 0)).toBe("Agent · Done");
    const wakeup = { ...task("c", "running", 1), kind: "wakeup" as const, wake_at: 1000 };
    expect(taskDetailText(wakeup, 760_000)).toBe("Wakeup · in 4 min");
    expect(taskDetailText(wakeup, 970_000)).toBe("Wakeup · in 30s");
    const cron = { ...task("d", "running", 1), kind: "cron" as const, wake_at: 1000 };
    expect(taskDetailText(cron, 760_000)).toBe("Scheduled · in 4 min");
  });
});

describe("section order", () => {
  it("keeps the saved order and puts a new section after its default neighbor", () => {
    expect(parseOrder("not json")).toEqual(["environment", "context", "pullRequests", "servers", "browser", "backgroundTasks"]);
    // A saved order from before the Browser section: Browser goes after Servers.
    expect(parseOrder(JSON.stringify(["servers", "environment", "context", "pullRequests", "backgroundTasks"]))).toEqual([
      "servers", "browser", "environment", "context", "pullRequests", "backgroundTasks",
    ]);
    expect(parseOrder(JSON.stringify(["context", "nope", "context"]))).toEqual(["environment", "context", "pullRequests", "servers", "browser", "backgroundTasks"]);
  });

  it("moves a section before or after another, and one step in the shown list", () => {
    const order = parseOrder("[]");
    expect(moveSection(order, "browser", "environment", false)[0]).toBe("browser");
    expect(moveSection(order, "environment", "backgroundTasks", true).at(-1)).toBe("environment");
    const shown: RailSection[] = ["environment", "servers", "browser"];
    const up = stepSection(order, shown, "browser", -1);
    expect(up.indexOf("browser")).toBeLessThan(up.indexOf("servers"));
    expect(stepSection(order, shown, "environment", -1)).toBe(order);
  });
});
