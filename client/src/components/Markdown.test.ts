import { describe, expect, it } from "vitest";
import { codeSpanUrl } from "./Markdown";

describe("codeSpanUrl", () => {
  it("finds a URL that the model wrote in backticks", () => {
    const sae = "https://www.grainger.com/category/fasteners/bolts-screws/hex-head-bolts/standard-hex-head-cap-screws";
    expect(codeSpanUrl(sae)).toBe(sae);
    const metric = `${sae}?attrs=System+of+Measurement%7CMetric&filters=attrs`;
    expect(codeSpanUrl(metric)).toBe(metric);
    expect(codeSpanUrl(" http://localhost:5173/ ")).toBe("http://localhost:5173/");
    expect(codeSpanUrl("<https://example.com/a>")).toBe("https://example.com/a");
  });

  it("leaves other code as code", () => {
    expect(codeSpanUrl("grainger-sae.html")).toBeNull();
    expect(codeSpanUrl("src/app.py:42")).toBeNull();
    expect(codeSpanUrl("curl https://example.com")).toBeNull();
    expect(codeSpanUrl("https://example.com and more")).toBeNull();
    expect(codeSpanUrl("ftp://example.com")).toBeNull();
    expect(codeSpanUrl("https://")).toBeNull();
  });
});
