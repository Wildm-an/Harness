import { describe, expect, it } from "vitest";
import { filterSessions, insertMention, mentionAt, mentionToken, resolveSessionRefs } from "./mentions";

describe("the @ menu of the prompt box", () => {
  it("finds the @ token at the caret", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("look at @src/ap", 15)).toEqual({ start: 8, query: "src/ap" });
    expect(mentionAt("look at @src/ap now", 15)).toEqual({ start: 8, query: "src/ap" });
    expect(mentionAt("mail a@b.com", 12)).toBeNull(); // An e-mail address is not a reference.
    expect(mentionAt("@src/app.py done", 16)).toBeNull(); // The caret is after the token.
  });

  it("puts the reference in the prompt", () => {
    expect(insertMention("look at @src/ap", 15, 8, "src/app.py")).toEqual({ text: "look at @src/app.py ", caret: 20 });
    expect(insertMention("@s and more", 2, 0, "session:abc")).toEqual({ text: "@session:abc and more", caret: 12 });
  });

  it("makes the token of a file or a session", () => {
    expect(mentionToken({ kind: "file", path: "src/" })).toBe("src/");
    expect(mentionToken({ kind: "session", session: { id: "abc", title: null, cwd: "/w", updated_at: 0 } })).toBe('"Untitled session"');
    expect(mentionToken({ kind: "session", session: { id: "abc", title: 'The "login" bug', cwd: "/w", updated_at: 0 } })).toBe(
      `"The 'login' bug"`,
    );
  });

  it("sends the id of each named session", () => {
    const refs = new Map([['"Login page"', "abc123"]]);
    expect(resolveSessionRefs('Compare @"Login page" with @src/app.py', refs)).toBe("Compare @session:abc123 with @src/app.py");
    expect(resolveSessionRefs('@"Login page" and @"Unknown"', refs)).toBe('@session:abc123 and @"Unknown"');
    expect(resolveSessionRefs('mail a@"Login page"', refs)).toBe('mail a@"Login page"');
  });

  it("filters the sessions by title, in the order of the list", () => {
    const s = (id: string, title: string | null, updated_at: number) => ({ id, title, cwd: "/w", updated_at });
    const all = [s("b2", "Fix the login bug", 3), s("c3", null, 2), s("a1", "Login page", 1)];
    expect(filterSessions(all, "login").map((x) => x.id)).toEqual(["b2", "a1"]);
    expect(filterSessions(all, "").map((x) => x.id)).toEqual(["b2", "c3", "a1"]);
    expect(filterSessions(all, "c3").map((x) => x.id)).toEqual(["c3"]);
  });
});
