import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tests run in Node: a window with a small localStorage.
function fakeWindow(limit = Infinity) {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  return { data, window: { localStorage, addEventListener: () => {} } };
}

const load = () => import("./PromptBox");

describe("the unsent prompt after the app closes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("comes back in the next run of the app", async () => {
    const fake = fakeWindow();
    vi.stubGlobal("window", fake.window);
    const first = await load();
    first.saveDraft("s1", "Fix the login page");
    first.saveDraftAttachments("s1", [{ id: "a1", label: "Annotation 1", detail: "x", text: "y" }]);
    vi.runAllTimers();

    vi.resetModules();
    const next = await load();
    expect(next.draftOf("s1")).toBe("Fix the login page");
    expect(next.storedDrafts(true).s1.attachments).toHaveLength(1);
  });

  it("is removed from storage when the user sends it", async () => {
    const fake = fakeWindow();
    vi.stubGlobal("window", fake.window);
    const first = await load();
    first.saveDraft("s1", "text");
    vi.runAllTimers();
    first.saveDraft("s1", "");
    vi.runAllTimers();
    expect(JSON.parse(fake.data.get(first.DRAFTS_STORAGE_KEY)!)).toEqual({});
  });

  it("keeps the text without the images when the images do not fit", async () => {
    const fake = fakeWindow(500);
    vi.stubGlobal("window", fake.window);
    const first = await load();
    first.saveDraft("s1", "Look at this");
    first.saveDraftAttachments("s1", [{ id: "i1", label: "Image", detail: "", text: "", image: `data:image/png;base64,${"A".repeat(1000)}` }]);
    vi.runAllTimers();

    vi.resetModules();
    const next = await load();
    expect(next.draftOf("s1")).toBe("Look at this");
    expect(next.storedDrafts(true).s1.attachments).toBeUndefined();
  });

  it("keeps only the newest drafts", async () => {
    const fake = fakeWindow();
    vi.stubGlobal("window", fake.window);
    const first = await load();
    for (let i = 0; i <= first.MAX_STORED_DRAFTS; i++) {
      vi.setSystemTime(1000 + i);
      first.saveDraft(`s${i}`, `text ${i}`);
    }
    vi.runAllTimers();
    const stored = JSON.parse(fake.data.get(first.DRAFTS_STORAGE_KEY)!);
    expect(Object.keys(stored)).toHaveLength(first.MAX_STORED_DRAFTS);
    expect(stored.s0).toBeUndefined();
  });
});
