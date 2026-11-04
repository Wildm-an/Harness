import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linksInPane, openLink, setLinksInPane, setPaneOpener } from "./openLink";

describe("the links of the chat", () => {
  const events: string[] = [];
  beforeEach(() => {
    // The tests run with no browser: a storage in memory, and a record of the window events.
    const data = new Map<string, string>();
    events.length = 0;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
      dispatchEvent: (e: Event) => events.push(e.type),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setPaneOpener(null);
  });

  it("open in the built-in browser by default", () => {
    expect(linksInPane()).toBe(true);
    const pane = vi.fn();
    setPaneOpener(pane);
    openLink("https://example.com/docs");
    expect(pane).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("tell the open views when the choice changes", () => {
    setLinksInPane(false);
    expect(linksInPane()).toBe(false);
    expect(events).toEqual(["harness:links-pref"]);
  });
});
