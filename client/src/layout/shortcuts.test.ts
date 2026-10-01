import { describe, expect, it } from "vitest";
import { isNewSessionShortcut, isSideChatShortcut, isSidebarShortcut, navShortcut, shortcutPane } from "./shortcuts";
import { chatHasFullHeight, defaultLayout, findGroupOf, group, movePane, normalize, togglePane, type LayoutNode } from "./model";

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

describe("the sidebar shortcut", () => {
  it("is Ctrl+B or Cmd+B, and not Ctrl+Shift+B (the Browser)", () => {
    expect(isSidebarShortcut(key("KeyB", { ctrl: true, key: "b" }))).toBe(true);
    expect(isSidebarShortcut(key("KeyB", { meta: true, key: "b" }))).toBe(true);
    expect(isSidebarShortcut(key("KeyB", { ctrl: true, shift: true, key: "B" }))).toBe(false);
    expect(shortcutPane(key("KeyB", { ctrl: true, key: "b" }))).toBeNull();
    expect(isSidebarShortcut(key("KeyB", { key: "b" }))).toBe(false);
  });
});

describe("the terminal layout", () => {
  it("opens the terminal on the right of the chat, and a second toggle closes it", () => {
    const open = togglePane(defaultLayout(), "terminal");
    const terminal = findGroupOf(open, "terminal");
    expect(terminal?.tabs).toEqual(["terminal"]); // Its own window, below the editor.
    expect(findGroupOf(open, "editor")).not.toBe(terminal);
    expect(chatHasFullHeight(open)).toBe(true);
    const closed = togglePane(open, "terminal");
    expect(findGroupOf(closed, "terminal")).toBeNull();
  });

  it("opens the browser in its own window", () => {
    const shown = togglePane(defaultLayout(), "browser");
    expect(findGroupOf(shown, "browser")?.tabs).toEqual(["browser"]);
  });
});

describe("the chat has the full height", () => {
  it("does not move a pane above or below the chat, or the chat above or below a pane", () => {
    const layout = togglePane(defaultLayout(), "terminal");
    const chat = findGroupOf(layout, "chat")!;
    const right = findGroupOf(layout, "terminal")!;
    const editor = findGroupOf(layout, "editor")!;
    expect(movePane(layout, "terminal", chat.id, "bottom")).toBe(layout);
    expect(movePane(layout, "terminal", chat.id, "top")).toBe(layout);
    expect(movePane(layout, "chat", right.id, "top")).toBe(layout);
    // Beside the chat, and above or beside another pane, are allowed.
    expect(movePane(layout, "terminal", chat.id, "right")).not.toBe(layout);
    expect(movePane(layout, "terminal", editor.id, "top")).not.toBe(layout);
    expect(chatHasFullHeight(movePane(layout, "terminal", editor.id, "top"))).toBe(true);
  });

  it("moves the chat out of a column in a saved layout", () => {
    const saved: LayoutNode = {
      type: "split",
      id: "s1",
      direction: "row",
      children: [
        { type: "split", id: "s2", direction: "column", children: [group(["chat"]), group(["terminal"])], sizes: [0.7, 0.3] },
        group(["editor", "browser"]),
      ],
      sizes: [0.45, 0.55],
    };
    const fixed = normalize(saved);
    expect(chatHasFullHeight(fixed)).toBe(true);
    expect(findGroupOf(fixed, "terminal")).not.toBeNull();
    expect(fixed.type === "split" && fixed.children[0].type === "group" && fixed.children[0].tabs).toEqual(["chat"]);
  });
});

describe("the back and forward keys", () => {
  it("uses Alt+Left and Alt+Right, as in Claude", () => {
    expect(navShortcut(key("ArrowLeft", { alt: true, key: "ArrowLeft" }))).toBe(-1);
    expect(navShortcut(key("ArrowRight", { alt: true, key: "ArrowRight" }))).toBe(1);
  });

  it("ignores the arrows with other modifier keys", () => {
    expect(navShortcut(key("ArrowLeft", { key: "ArrowLeft" }))).toBeNull();
    expect(navShortcut(key("ArrowLeft", { alt: true, ctrl: true, key: "ArrowLeft" }))).toBeNull();
    expect(navShortcut(key("ArrowRight", { alt: true, shift: true, key: "ArrowRight" }))).toBeNull();
  });
});

describe("the new session key", () => {
  it("is Ctrl+N or Cmd+N, with no other modifier", () => {
    const key = (k: Partial<KeyboardEvent>) => ({ code: "KeyN", key: "n", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });
    expect(isNewSessionShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isNewSessionShortcut(key({ metaKey: true }))).toBe(true);
    expect(isNewSessionShortcut(key({}))).toBe(false);
    expect(isNewSessionShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("the side chat key", () => {
  it("is Ctrl+; or Cmd+;, with no other modifier", () => {
    const key = (k: Partial<KeyboardEvent>) => ({ code: "Semicolon", key: ";", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });
    expect(isSideChatShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSideChatShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSideChatShortcut(key({}))).toBe(false);
    expect(isSideChatShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
