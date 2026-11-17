import { describe, expect, it } from "vitest";
import type { RunningSession, SessionSummary } from "../daemon/protocol";
import { addUndoToast } from "./errorRoute";
import {
  applyUpdates,
  compareManual,
  dropAction,
  dropPositions,
  dropUpdates,
  movePositions,
  nextWake,
  sectionOf,
  snoozeChoices,
  threadSections,
  topPosition,
  toOrganization,
  trackStarts,
  undoKeyAllowed,
  undoText,
  undoUpdates,
  whenText,
} from "./threads";
import { dropIndex } from "../components/ThreadsList";

const NOW = 1_800_000_000;

function s(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, cwd: "/p", provider: "fake", model: "m", title: id, created_at: 100, updated_at: 100, ...extra };
}

const run = (id: string, waiting = false): [string, RunningSession] => [id, { session_id: id, waiting }];

describe("sections", () => {
  it("puts each session in its section", () => {
    expect(sectionOf(s("a", { archived: true, pinned: true }), undefined, NOW)).toBe("settled");
    expect(sectionOf(s("a", { pinned: true }), { session_id: "a", waiting: false }, NOW)).toBe("pinned");
    expect(sectionOf(s("a"), { session_id: "a", waiting: false }, NOW)).toBe("working");
    // A session that waits for input stays in Active, also when it is snoozed.
    expect(sectionOf(s("a", { snoozed_until: NOW + 60 }), { session_id: "a", waiting: true }, NOW)).toBe("active");
    expect(sectionOf(s("a", { snoozed_until: NOW + 60 }), undefined, NOW)).toBe("snoozed");
    expect(sectionOf(s("a", { snoozed_until: NOW - 60 }), undefined, NOW)).toBe("active"); // The wake time is past.
    expect(sectionOf(s("a"), undefined, NOW)).toBe("active");
  });

  it("orders the manual sections by position, then the newest", () => {
    const list = [s("new", { created_at: 300 }), s("p2", { position: 2 }), s("old", { created_at: 200 }), s("p1", { position: 1 })];
    expect([...list].sort(compareManual).map((x) => x.id)).toEqual(["p1", "p2", "new", "old"]);
  });

  it("orders working by start, snoozed by wake, and settled by settle time", () => {
    const sessions = [
      s("w1"),
      s("w2"),
      s("z1", { snoozed_until: NOW + 500 }),
      s("z2", { snoozed_until: NOW + 100 }),
      s("x1", { archived: true, archived_at: 10 }),
      s("x2", { archived: true, archived_at: 20 }),
    ];
    const running = new Map([run("w1"), run("w2")]);
    const out = threadSections(sessions, running, NOW, new Map([["w1", 5], ["w2", 9]]));
    expect(out.working.map((x) => x.id)).toEqual(["w2", "w1"]);
    expect(out.snoozed.map((x) => x.id)).toEqual(["z2", "z1"]);
    expect(out.settled.map((x) => x.id)).toEqual(["x2", "x1"]);
    expect(nextWake(sessions, NOW)).toBe(NOW + 100);
  });

  it("keeps the start time of a session while it works", () => {
    const first = trackStarts(new Map(), [{ session_id: "a", waiting: false }], 10);
    expect(trackStarts(first, [{ session_id: "a", waiting: false }], 20)).toBe(first);
    const next = trackStarts(first, [{ session_id: "a", waiting: false }, { session_id: "b", waiting: false }], 30);
    expect([...next]).toEqual([["a", 10], ["b", 30]]);
    expect(trackStarts(next, [{ session_id: "b", waiting: true }], 40).size).toBe(0); // Waiting is not working.
  });
});

describe("positions", () => {
  it("puts a drop between two neighbors", () => {
    const list = [s("a", { position: 1 }), s("b", { position: 2 })];
    expect(dropPositions(list, 1, "x")).toEqual([{ id: "x", position: 1.5 }]);
    expect(dropPositions(list, 0, "x")).toEqual([{ id: "x", position: 0 }]);
    expect(dropPositions(list, 2, "x")).toEqual([{ id: "x", position: 3 }]);
    expect(dropPositions([], 0, "x")).toEqual([{ id: "x", position: 0 }]);
  });

  it("gives positions to the rows with none above the drop place", () => {
    const list = [s("a", { position: 4 }), s("b"), s("c"), s("d")];
    expect(dropPositions(list, 3, "x")).toEqual([
      { id: "b", position: 5 },
      { id: "c", position: 6 },
      { id: "x", position: 7 },
    ]);
    expect(dropPositions([s("b"), s("c")], 1, "x")).toEqual([
      { id: "b", position: 1 },
      { id: "x", position: 2 },
    ]);
  });

  it("moves up and down, and finds the top", () => {
    const list = [s("a", { position: 1 }), s("b", { position: 2 }), s("c", { position: 3 })];
    expect(movePositions(list, "c", -1)).toEqual([{ id: "c", position: 1.5 }]);
    expect(movePositions(list, "a", 1)).toEqual([{ id: "a", position: 2.5 }]);
    expect(movePositions(list, "a", -1)).toEqual([]);
    expect(topPosition(list)).toBe(0);
    expect(topPosition([s("x")])).toBe(0);
  });
});

describe("drops", () => {
  it("names the action of a drop", () => {
    expect(dropAction("active", "active")).toBe("reorder");
    expect(dropAction("active", "pinned")).toBe("pin");
    expect(dropAction("pinned", "active")).toBe("unpin");
    expect(dropAction("pinned", "settled")).toBe("settle");
    expect(dropAction("settled", "active")).toBe("unsettle");
    expect(dropAction("snoozed", "active")).toBe("wake");
    expect(dropAction("active", "snoozed")).toBeNull(); // A snooze needs a wake time.
    expect(dropAction("settled", "settled")).toBeNull();
    expect(dropAction("working", "pinned")).toBeNull();
  });

  it("gives the updates of a drop", () => {
    const list = [s("a", { position: 1 })];
    expect(dropUpdates("pin", s("x"), list, 1)).toEqual([{ id: "x", fields: { position: 2, pinned: true } }]);
    expect(dropUpdates("settle", s("x", { pinned: true }), list, 0)).toEqual([{ id: "x", fields: { archived: true, pinned: false } }]);
    expect(dropUpdates("unsettle", s("x", { archived: true }), list, 0)).toEqual([{ id: "x", fields: { position: 0, archived: false } }]);
    expect(dropUpdates("wake", s("x", { snoozed_until: NOW }), list, 0)).toEqual([{ id: "x", fields: { position: 0, snoozed_until: null } }]);
    expect(dropUpdates("pin", s("x", { archived: true }), [], 0)[0].fields).toEqual({ position: 0, pinned: true, archived: false });
  });

  it("finds the drop place under the pointer", () => {
    const rects = [{ top: 0, height: 20 }, { top: 20, height: 20 }];
    expect(dropIndex(rects, 5)).toBe(0);
    expect(dropIndex(rects, 15)).toBe(1);
    expect(dropIndex(rects, 39)).toBe(2);
  });
});

describe("undo", () => {
  it("puts back the earlier values, also the pinned position", () => {
    const before = [s("a", { pinned: true, position: 3 }), s("b", { snoozed_until: null })];
    const updates = [
      { id: "a", fields: { archived: true, pinned: false } },
      { id: "b", fields: { snoozed_until: NOW + 60, auto_archive: false, position: 1 } },
    ];
    expect(undoUpdates(before, updates)).toEqual([
      { id: "a", fields: { archived: false, pinned: true } },
      { id: "b", fields: { snoozed_until: null, auto_archive: true, position: null } },
    ]);
  });

  it("applies updates at once, with the settle time", () => {
    const out = applyUpdates([s("a"), s("b", { archived: true, archived_at: 5 })], [
      { id: "a", fields: { archived: true, pinned: false } },
      { id: "b", fields: { archived: false } },
    ], NOW);
    expect(out[0]).toMatchObject({ archived: true, pinned: false, archived_at: NOW });
    expect(out[1]).toMatchObject({ archived: false, archived_at: null });
  });

  it("writes the popup texts", () => {
    expect(undoText("unpin", "Fix bug")).toBe("Unpinned Fix bug.");
    expect(undoText("settle", null)).toBe("Settled Untitled session.");
    expect(undoText("snooze", "Fix bug", NOW + 60, NOW)).toMatch(/^Snoozed Fix bug until .+\.$/);
  });

  it("keeps the time of the undo popup", () => {
    const list = addUndoToast([], "Settled A.", () => undefined, 1, 5000);
    expect(list[0].ms).toBe(5000);
    expect(addUndoToast([], "Archived 3 sessions.", () => undefined, 2)[0].ms).toBeUndefined();
  });

  it("runs Ctrl+Z only outside the text fields, the editor, and the terminal", () => {
    // A fake element: closest() finds a match when the element is inside one of the given parts.
    const el = (inside: string[], editable = false) =>
      ({ isContentEditable: editable, closest: (sel: string) => (inside.some((p) => sel.includes(p)) ? {} : null) }) as unknown as Element;
    expect(undoKeyAllowed(el([]))).toBe(true);
    expect(undoKeyAllowed(null)).toBe(true);
    expect(undoKeyAllowed(el(["input"]))).toBe(false);
    expect(undoKeyAllowed(el([".monaco-editor"]))).toBe(false);
    expect(undoKeyAllowed(el([".xterm"]))).toBe(false);
    expect(undoKeyAllowed(el([], true))).toBe(false);
  });
});

describe("snooze", () => {
  it("gives the snooze choices", () => {
    const wed = new Date(2026, 10, 18, 15, 30); // A Wednesday.
    const [hour, three, tomorrow, monday] = snoozeChoices(wed);
    expect(hour.label).toBe("1 hour");
    expect(hour.until).toBe(wed.getTime() / 1000 + 3600);
    expect(three.until).toBe(wed.getTime() / 1000 + 3 * 3600);
    expect(tomorrow.label).toMatch(/^Tomorrow, /);
    expect(new Date(tomorrow.until * 1000)).toEqual(new Date(2026, 10, 19, 9, 0));
    expect(monday.label).toMatch(/^Next Monday, /);
    expect(new Date(monday.until * 1000)).toEqual(new Date(2026, 10, 23, 9, 0));
    // On a Monday, "Next Monday" is the Monday of the next week.
    const mon = new Date(2026, 10, 16, 8, 0);
    expect(new Date(snoozeChoices(mon)[3].until * 1000)).toEqual(new Date(2026, 10, 23, 9, 0));
  });

  it("writes a wake time", () => {
    const now = new Date(2026, 10, 18, 15, 30).getTime() / 1000;
    expect(whenText(new Date(2026, 10, 18, 17, 0).getTime() / 1000, now)).not.toMatch(/tomorrow/);
    expect(whenText(new Date(2026, 10, 19, 9, 0).getTime() / 1000, now)).toMatch(/^tomorrow /);
    expect(whenText(new Date(2026, 10, 23, 9, 0).getTime() / 1000, now)).toMatch(/^Mon /);
  });
});

describe("setting", () => {
  it("reads the sidebar organization", () => {
    expect(toOrganization("threads")).toBe("threads");
    expect(toOrganization("x")).toBe("sessions");
    expect(toOrganization(null)).toBe("sessions");
  });
});
