import { describe, expect, it } from "vitest";
import type { PermissionItem } from "../chat/state";
import { choiceForKey, permissionChoices } from "./PermissionCard";

const item = (rule: string | null): PermissionItem => ({ kind: "permission", id: "r1", tool: "bash", input: { command: "ls" }, diff: null, rule });

describe("the permission card", () => {
  it("has the buttons of Claude desktop from left to right", () => {
    expect(permissionChoices(item("bash(ls:*)"))).toEqual(["deny", "allow_always", "allow_once"]);
  });

  it("has no Always allow for a request with no rule", () => {
    expect(permissionChoices(item(null))).toEqual(["deny", "allow_once"]);
  });

  it("selects the buttons with the number keys", () => {
    const choices = permissionChoices(item("bash(ls:*)"));
    expect(["1", "2", "3", "4"].map((k) => choiceForKey(choices, k))).toEqual(["deny", "allow_always", "allow_once", null]);
    expect(choiceForKey(permissionChoices(item(null)), "3")).toBeNull();
  });
});
