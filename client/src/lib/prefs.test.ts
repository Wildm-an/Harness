import { describe, expect, it } from "vitest";
import { appPrefs, mergePrefs } from "./prefs";

function storage(items: Record<string, string>): Pick<Storage, "length" | "key" | "getItem"> {
  const keys = Object.keys(items);
  return { length: keys.length, key: (i) => keys[i] ?? null, getItem: (k) => items[k] ?? null };
}

describe("the app settings file", () => {
  it("copies only the harness. keys", () => {
    expect(appPrefs(storage({ "harness.appearance": "dark", "other": "x", "harness.density": "compact" }))).toEqual({
      "harness.appearance": "dark",
      "harness.density": "compact",
    });
  });

  it("wins over localStorage at the start, and keeps the keys that only localStorage has", () => {
    const local = { "harness.appearance": "light", "harness.view": "ide" };
    expect(mergePrefs(local, { "harness.appearance": "dark", "harness.accentColor": "blue" })).toEqual({
      "harness.appearance": "dark",
      "harness.view": "ide",
      "harness.accentColor": "blue",
    });
    expect(mergePrefs(local, null)).toEqual(local);
  });
});
