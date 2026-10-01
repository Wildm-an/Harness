import { describe, expect, it } from "vitest";
import { isSettingsShortcut } from "./SettingsDialog";

describe("the settings key", () => {
  it("is Ctrl+, or Cmd+, with no other modifier", () => {
    const key = (k: Partial<KeyboardEvent>) => ({ code: "Comma", key: ",", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });
    expect(isSettingsShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSettingsShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSettingsShortcut(key({}))).toBe(false);
    expect(isSettingsShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});
