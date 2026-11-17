import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_FIELDS } from "../components/SettingsDialog";
import { SANDBOX_LABEL } from "../components/SandboxSetting";
import { SETTINGS_INDEX, findSetting, searchSettings } from "./settingsIndex";

const labels = (q: string) => searchSettings(q).map((e) => e.label);

describe("the search of Settings", () => {
  it("finds a setting by its name, best match first", () => {
    expect(labels("time")[0]).toBe("Time format");
    expect(labels("accent")).toEqual(["Accent color"]);
    expect(labels("")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("finds a setting by its help, its section, its page, or other words", () => {
    expect(labels("dark mode")).toContain("Theme");
    expect(labels("tray")).toContain("Keep running in the background");
    expect(labels("dictation")).toEqual(expect.arrayContaining(["Speech model", "Clean up dictation", "Cleanup model"]));
    expect(labels("deny")).toContain("Deny");
    expect(labels("claude max")).toContain("Account");
  });

  it("needs each word of the search", () => {
    expect(labels("web search brave")).toEqual(expect.arrayContaining(["Web search", "API key"]));
    expect(labels("zzzz")).toEqual([]);
  });

  it("names each setting row of the Settings pages", () => {
    // Each <Row label="..."> of the pages is in the index, so a new setting cannot be missing from the search.
    const files = ["SettingsDialog.tsx", "YourHarnessSettings.tsx", "DictationSettings.tsx", "UpdatesPage.tsx", "PermissionRulesSettings.tsx"];
    const indexed = new Set(SETTINGS_INDEX.map((e) => e.label));
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(__dirname, "../components", file), "utf-8");
      for (const m of text.matchAll(/<Row\s+label="([^"]+)"/g)) if (!indexed.has(m[1])) missing.push(`${file}: ${m[1]}`);
    }
    for (const [, label] of INSTRUCTION_FIELDS) if (!indexed.has(label)) missing.push(label);
    if (!indexed.has(SANDBOX_LABEL)) missing.push(SANDBOX_LABEL);
    expect(missing).toEqual([]);
  });
});

describe("the setting on its page", () => {
  // Small fake elements: the tests run with no DOM.
  const el = (id: string, text: string, row: string | null = null) => ({ id, textContent: text, closest: () => (row ? { id: row } : null) });
  const root = (groups: Record<string, ReturnType<typeof el>[]>) =>
    ({ querySelectorAll: (selector: string) => groups[Object.keys(groups).find((k) => selector.startsWith(k)) ?? ""] ?? [] }) as unknown as ParentNode;

  it("finds the row of a setting label, else a heading or a button", () => {
    const page = root({
      ".setting-text": [el("label", "Time format", "row")],
      ".settings-section": [el("section", "Keyboard shortcuts")],
      label: [el("btn", "Add agent · 12")],
    });
    expect((findSetting(page, "Time format") as unknown as { id: string }).id).toBe("row");
    expect((findSetting(page, "Keyboard shortcuts") as unknown as { id: string }).id).toBe("section");
    expect((findSetting(page, "Add agent") as unknown as { id: string }).id).toBe("btn");
    expect(findSetting(page, "Nothing")).toBeNull();
  });
});
