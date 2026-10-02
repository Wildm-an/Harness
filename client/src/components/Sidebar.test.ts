import { describe, expect, it } from "vitest";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";
import { filterStatus, folderName, groupByProject, mergeOrder, moveKey, orderGroups, pathKey, sessionState, sortSessions } from "./Sidebar";
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
