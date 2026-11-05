import { describe, expect, it } from "vitest";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";
import { ancestry, filterStatus, folderName, groupByProject, hiddenActivity, mergeOrder, moveKey, nestSessions, orderGroups, pathKey, sessionState, sessionsToShowFolded, sortSessions, topSessions } from "./Sidebar";
import { activityLine, nestedLabel } from "./SessionRow";
import { searchSessions } from "./SessionSearch";

const session = (id: string, cwd: string, updated: number): SessionSummary => ({
  id, cwd, provider: "demo", model: "scripted", title: id, created_at: updated, updated_at: updated,
});
const project = (id: string, name: string, path: string): ProjectItem =>
  ({ id, name, path, exists: true, sessions: 0 }) as ProjectItem;

describe("the sidebar projects", () => {
  it("groups the sessions by folder, with the newest project first", () => {
    const groups = groupByProject(
      [session("a1", "C:\\work\\app", 100), session("b1", "C:\\work\\site", 300), session("a2", "c:/work/app/", 200)],
      [project("p1", "My app", "C:\\work\\app")],
    );
    expect(groups.map((g) => [g.name, g.projectId, g.sessions.map((s) => s.id)])).toEqual([
      ["site", null, ["b1"]], // A folder that is not a saved project uses the folder name.
      ["My app", "p1", ["a2", "a1"]], // Windows paths match with no case and with either separator.
    ]);
  });

  it("keeps a saved project with no session, after the others", () => {
    const groups = groupByProject([session("x", "/home/me/x", 5)], [project("p2", "Empty", "/home/me/empty"), project("p3", "A", "/home/me/a")]);
    expect(groups.map((g) => g.name)).toEqual(["x", "A", "Empty"]);
    expect(groups[2].sessions).toEqual([]);
  });

  it("keeps the order of the user when a new session starts", () => {
    const projects = [project("p1", "A", "/a"), project("p2", "B", "/b")];
    const order = ["/a", "/b"];
    const before = orderGroups(groupByProject([session("a1", "/a", 1), session("b1", "/b", 2)], projects), order);
    expect(before.map((g) => g.name)).toEqual(["A", "B"]);
    // A new session in B: B stays second, and the new session is at the top of B.
    const after = orderGroups(groupByProject([session("a1", "/a", 1), session("b1", "/b", 2), session("b2", "/b", 3)], projects), order);
    expect(after.map((g) => [g.name, g.sessions.map((s) => s.id)])).toEqual([["A", ["a1"]], ["B", ["b2", "b1"]]]);
  });

  it("puts a folder that is not in the order first", () => {
    const groups = groupByProject([session("a1", "/a", 1), session("n1", "/new", 5)], []);
    expect(orderGroups(groups, ["/a"]).map((g) => g.key)).toEqual(["/new", "/a"]);
  });

  it("moves a project before or after another project", () => {
    expect(moveKey(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(moveKey(["a", "b", "c"], "a", "b", true)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "b", "b", true)).toEqual(["a", "b", "c"]);
  });

  it("keeps the order of folders that are not shown", () => {
    expect(mergeOrder(["b", "a"], ["a", "x", "b"])).toEqual(["b", "a", "x"]);
  });

  it("compares POSIX paths with case", () => {
    expect(pathKey("/home/Me/App/")).toBe("/home/Me/App");
    expect(pathKey("C:\\Work\\App")).toBe("c:/work/app");
  });

  it("shows the last folder of a path", () => {
    expect(folderName("C:\\work\\app")).toBe("app");
    expect(folderName("/home/me/app/")).toBe("app");
  });
});

describe("the session state", () => {
  it("is Idle, Running, Awaiting input, or Unread response", () => {
    expect(sessionState(undefined, false)).toEqual({ kind: "idle", label: "Idle" });
    expect(sessionState({ session_id: "a", waiting: false }, false)).toEqual({ kind: "running", label: "Running" });
    expect(sessionState({ session_id: "a", waiting: true }, false).kind).toBe("awaiting");
    expect(sessionState(undefined, true)).toEqual({ kind: "unread", label: "Unread response" });
    // A new turn in a session with an unread response shows Running.
    expect(sessionState({ session_id: "a", waiting: false }, true).kind).toBe("running");
  });
});

describe("sidebar view", () => {
  const s = (id: string, updated: number, created: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    id, cwd: "C:/work/app", provider: "p", model: "m", title: id, created_at: created, updated_at: updated, ...extra,
  });
  const list = [s("a", 30, 1), s("b", 20, 3, { archived: true }), s("c", 10, 2)];

  it("filters by status", () => {
    expect(filterStatus(list, "active").map((x) => x.id)).toEqual(["a", "c"]);
    expect(filterStatus(list, "archived").map((x) => x.id)).toEqual(["b"]);
    expect(filterStatus(list, "all")).toHaveLength(3);
  });

  it("sorts by the last activity or the creation time", () => {
    expect(sortSessions(list, "activity").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(sortSessions(list, "created").map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("searches the names and the folders with all words", () => {
    const named = [s("x", 2, 1, { title: "Fix the login" }), s("y", 1, 1, { title: "Add tests", cwd: "C:/work/login-page" })];
    expect(searchSessions(named, "login").map((x) => x.id)).toEqual(["x", "y"]);
    expect(searchSessions(named, "fix login").map((x) => x.id)).toEqual(["x"]);
    expect(searchSessions(named, "nothing")).toEqual([]);
    expect(searchSessions(named, "  ")).toHaveLength(2);
  });
});

describe("a folded project", () => {
  it("still shows the sessions that run, wait for input, or have an unread reply", () => {
    const list = ["idle", "busy", "asks", "new"].map((id, i) => session(id, "/p", i));
    const running = new Map([
      ["busy", { session_id: "busy", waiting: false }],
      ["asks", { session_id: "asks", waiting: true }],
    ]);
    expect(sessionsToShowFolded(list, running, new Set(["new"])).map((s) => s.id)).toEqual(["busy", "asks", "new"]);
    expect(sessionsToShowFolded(list, new Map(), new Set())).toEqual([]);
    // The open session stays in view too.
    expect(sessionsToShowFolded(list, new Map(), new Set(), "idle").map((s) => s.id)).toEqual(["idle"]);
  });
});

describe("nested sessions", () => {
  const s = (id: string, parent: string | null, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    id, cwd: "/p", provider: "p", model: "m", title: id, created_at: 1, updated_at: 1, parent_id: parent, ...extra,
  });
  const list = [s("top", null), s("fork", "top"), s("deep", "fork"), s("pinned", "top", { pinned: true }), s("lost", "gone")];

  it("puts a session under its listed parent", () => {
    const children = nestSessions(list);
    expect([...children.entries()].map(([k, v]) => [k, v.map((x) => x.id)])).toEqual([["top", ["fork"]], ["fork", ["deep"]]]);
    // A pinned session and a session with a parent that is not listed stay at the top level.
    expect(topSessions(list, children).map((x) => x.id)).toEqual(["top", "pinned", "lost"]);
  });

  it("finds the parents of the open session", () => {
    const children = nestSessions(list);
    expect(ancestry("deep", list, children)).toEqual(["deep", "fork", "top"]);
    expect(ancestry("top", list, children)).toEqual(["top"]);
    expect(ancestry(null, list, children)).toEqual([]);
    expect(ancestry("missing", list, children)).toEqual([]);
  });

  it("counts the hidden nested sessions that work, await input, or are unread", () => {
    const children = nestSessions(list);
    const states: Record<string, "idle" | "running" | "awaiting" | "unread"> = { fork: "unread", deep: "awaiting" };
    expect(hiddenActivity("top", children, (id) => states[id] ?? "idle")).toEqual({ running: 0, awaiting: 1, unread: 1 });
    expect(hiddenActivity("fork", children, (id) => (id === "deep" ? "running" : "idle"))).toEqual({ running: 1, awaiting: 0, unread: 0 });
    expect(hiddenActivity("deep", children, () => "unread")).toEqual({ running: 0, awaiting: 0, unread: 0 }); // No nested sessions.
  });

  it("writes the line under a closed row", () => {
    expect(activityLine(1, { running: 1, awaiting: 0, unread: 0 })).toBe("1 nested session · 1 working");
    expect(activityLine(3, { running: 1, awaiting: 1, unread: 2 })).toBe("3 nested sessions · 1 working · 1 awaiting input · 2 unread");
    expect(activityLine(2, { running: 0, awaiting: 0, unread: 0 })).toBeNull(); // No line for idle sessions.
  });

  it("names the arrow button with the count", () => {
    expect(nestedLabel({ count: 1, open: false })).toBe("Show 1 nested session");
    expect(nestedLabel({ count: 2, open: true })).toBe("Hide 2 nested sessions");
  });
});
