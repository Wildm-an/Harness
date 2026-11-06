import { describe, expect, it } from "vitest";
import { codeSpanUrl, streamBlocks } from "./Markdown";

describe("streamBlocks", () => {
  it("splits at blank lines before a line at column 0", () => {
    expect(streamBlocks("# Title\n\nOne.\n\nTwo")).toEqual(["# Title", "One.", "Two"]);
  });

  it("keeps an indented continuation and a code fence in one block", () => {
    const list = "1. Step\n\n   More of the step\n\n2. Next";
    expect(streamBlocks(list)).toEqual(["1. Step\n\n   More of the step", "2. Next"]);
    const code = "```py\na = 1\n\nb = 2\n```\n\nAfter";
    expect(streamBlocks(code)).toEqual(["```py\na = 1\n\nb = 2\n```", "After"]);
  });

  it("keeps the last block while it is empty, and the text is the same", () => {
    expect(streamBlocks("One.\n\n")).toEqual(["One.\n\n"]);
    const text = "A\n\nB\n\n```\nopen fence\n\nstill code";
    expect(streamBlocks(text).join("\n\n")).toBe(text);
  });
});

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
