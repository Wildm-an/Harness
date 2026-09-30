import { describe, expect, it } from "vitest";
import { shortcutPane } from "./shortcuts";
import { defaultLayout, findGroupOf, groups, openBelow, togglePane } from "./model";

const key = (code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; key?: string } = {}) => ({
  code,
  key: mods.key ?? "",
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("the pane shortcuts", () => {
  it("uses the keys of the Code tab of Claude, and Ctrl+Shift+F for Files", () => {
    expect(shortcutPane(key("KeyB", { ctrl: true, shift: true }))).toBe("browser");
    expect(shortcutPane(key("KeyD", { ctrl: true, shift: true }))).toBe("diff");
    expect(shortcutPane(key("KeyF", { ctrl: true, shift: true }))).toBe("editor");
    expect(shortcutPane(key("Backquote", { ctrl: true }))).toBe("terminal");
    expect(shortcutPane(key("", { ctrl: true, key: "`" }))).toBe("terminal"); // No code.
  });

  it("accepts Cmd on macOS, but the terminal key uses Ctrl on every platform", () => {
    expect(shortcutPane(key("KeyD", { meta: true, shift: true }))).toBe("diff");
    expect(shortcutPane(key("Backquote", { meta: true }))).toBeNull();
  });

  it("ignores other keys", () => {
    expect(shortcutPane(key("KeyB", { ctrl: true }))).toBeNull(); // No Shift.
    expect(shortcutPane(key("KeyB", { shift: true }))).toBeNull(); // No Ctrl.
    expect(shortcutPane(key("KeyB", { ctrl: true, shift: true, alt: true }))).toBeNull();
    expect(shortcutPane(key("Backquote"))).toBeNull();
    expect(shortcutPane(key("KeyX", { ctrl: true, shift: true }))).toBeNull();
  });
});

describe("the terminal layout", () => {
  it("opens the terminal below the chat, and a second toggle closes it", () => {
    const open = openBelow(defaultLayout(), "terminal", "chat");
    const terminal = findGroupOf(open, "terminal");
    expect(terminal?.tabs).toEqual(["terminal"]);
    expect(open.type).toBe("split");
    // The chat and the terminal are in a column split.
    const column = open.type === "split" ? open.children[0] : null;
    expect(column?.type === "split" && column.direction).toBe("column");
    const closed = togglePane(open, "terminal");
    expect(findGroupOf(closed, "terminal")).toBeNull();
    expect(groups(closed)).toHaveLength(2);
  });

  it("shows a pane that is not the active tab, and does not close it", () => {
    const layout = defaultLayout(); // The editor is active, the browser is the second tab.
    const shown = togglePane(layout, "browser");
    expect(findGroupOf(shown, "browser")?.active).toBe("browser");
  });
});
