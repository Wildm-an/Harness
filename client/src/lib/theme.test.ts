import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_WIDTHS,
  accentColor,
  accentTokens,
  cleanAccent,
  cleanFontName,
  codeFontStack,
  darkCodeTheme,
  interfaceFont,
  lightCodeTheme,
  luminance,
  textOn,
  transcriptWidth,
} from "./theme";

describe("the accent color", () => {
  it("is white by default", () => {
    expect(accentColor()).toBe("white");
  });

  it("keeps presets and #rrggbb colors, and drops other values", () => {
    expect(cleanAccent("blue")).toBe("blue");
    expect(cleanAccent("#AABBCC")).toBe("#aabbcc");
    expect(cleanAccent("red; color: x")).toBe("white");
    expect(cleanAccent("#abc")).toBe("white");
  });

  it("uses the clay values of the CSS for clay", () => {
    expect(accentTokens("clay", "dark")).toBeNull();
  });

  it("is white on the dark theme and black on the light theme", () => {
    expect(accentTokens("white", "dark")!["--accent-fill"]).toBe("#faf9f5");
    expect(accentTokens("white", "dark")!["--accent-text"]).toBe("#1f1e1d");
    expect(accentTokens("white", "light")!["--accent-fill"]).toBe("#1f1e1d");
    expect(accentTokens("white", "light")!["--accent-text"]).toBe("#ffffff");
  });

  it("puts readable text on the fill", () => {
    expect(textOn("#ffff00")).toBe("#1f1e1d");
    expect(textOn("#2a78d6")).toBe("#ffffff");
  });

  it("makes a light custom color darker as text on the light theme", () => {
    const tokens = accentTokens("#ffff00", "light")!;
    expect(tokens["--accent-fill"]).toBe("#ffff00");
    expect(luminance(tokens["--accent"])).toBeLessThan(luminance("#ffff00"));
  });

  it("makes a dark custom color lighter as text on the dark theme", () => {
    const tokens = accentTokens("#101060", "dark")!;
    expect(luminance(tokens["--accent"])).toBeGreaterThan(luminance("#101060"));
  });
});

describe("the code font", () => {
  it("removes the characters that can break the CSS value", () => {
    expect(cleanFontName(' "Fira Code"; }')).toBe("Fira Code");
    expect(cleanFontName("Cascadia\\ Mono (NF)")).toBe("Cascadia Mono NF");
    expect(cleanFontName("  Iosevka   Term  ")).toBe("Iosevka Term");
  });

  it("keeps the name to 64 characters", () => {
    expect(cleanFontName("a".repeat(100))).toHaveLength(64);
  });

  it("puts the fallback fonts after the name", () => {
    expect(codeFontStack("Fira Code")).toMatch(/^"Fira Code", "JetBrains Mono", .*monospace$/);
  });

  it("uses JetBrains Mono when the name is empty", () => {
    expect(codeFontStack("")).toMatch(/^"JetBrains Mono", /);
    expect(codeFontStack(' ""; ')).toBe(codeFontStack(""));
  });
});

describe("the appearance defaults", () => {
  it("use the default values when no preference is saved", () => {
    expect(interfaceFont()).toBe("system");
    expect(transcriptWidth()).toBe("default");
    expect(lightCodeTheme()).toBe("vs");
    expect(darkCodeTheme()).toBe("vs-dark");
  });

  it("keep the default transcript width of the CSS", () => {
    expect(TRANSCRIPT_WIDTHS.default).toBe("780px");
    expect(TRANSCRIPT_WIDTHS.full).toBe("none");
  });
});
