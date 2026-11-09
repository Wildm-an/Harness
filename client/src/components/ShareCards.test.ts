import { describe, expect, it } from "vitest";
import { pageHost } from "./ShareCards";

describe("pageHost", () => {
  it("gives the host of a page for the browser card", () => {
    expect(pageHost("https://github.com/Wildm-an/Harness/actions/runs/48")).toBe("github.com");
    expect(pageHost("http://127.0.0.1:5173/about")).toBe("127.0.0.1:5173");
    expect(pageHost("about:blank")).toBe("about");
    expect(pageHost("not a url")).toBe("not a url");
  });
});
