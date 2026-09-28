import { describe, expect, it } from "vitest";
import { deviceBounds, normalizeAddress } from "./BrowserPane";

describe("browser address", () => {
  it("adds a scheme to an address", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("127.0.0.1:8080/docs")).toBe("http://127.0.0.1:8080/docs");
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeAddress("")).toBe("about:blank");
  });
});

describe("device bounds", () => {
  const area = { x: 100, y: 50, width: 1000, height: 900 };

  it("uses the full pane for the desktop size", () => {
    expect(deviceBounds(area, "desktop")).toEqual(area);
  });

  it("centers a phone in the pane", () => {
    expect(deviceBounds(area, "phone")).toEqual({ x: 412.5, y: 94, width: 375, height: 812 });
  });

  it("shrinks a device that is larger than the pane", () => {
    const b = deviceBounds({ x: 0, y: 0, width: 600, height: 500 }, "tablet");
    expect(b).toEqual({ x: 0, y: 0, width: 600, height: 500 });
  });
});
