import { describe, expect, it } from "vitest";
import type { TaskItem } from "../daemon/protocol";
import { RAIL_SECTIONS, contextShare, parseFolded, percentText, prStateText, railShown, sortTasks, taskSummary, toggleFolded } from "./sessionRail";

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
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(["environment", "context", "pullRequests", "servers", "backgroundTasks"]);
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
