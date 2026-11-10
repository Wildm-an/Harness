import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";
import { normalizeMath } from "./math";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const count = (s: string, part: string) => s.split(part).length - 1;

describe("normalizeMath", () => {
  it("keeps text with no equation", () => {
    const text = String.raw`Plain text, a path C:\Users\me, and ${"`code`"}.`;
    expect(normalizeMath(text)).toBe(text);
  });

  it("escapes money and shell variables", () => {
    expect(normalizeMath("It costs $5 and $10.")).toBe(String.raw`It costs \$5 and \$10.`);
    expect(normalizeMath("From $5-$10 (about $6).")).toBe(String.raw`From \$5-\$10 (about \$6).`);
    expect(normalizeMath("Set $HOME and $PATH now.")).toBe(String.raw`Set \$HOME and \$PATH now.`);
    expect(normalizeMath(String.raw`Already \$5.`)).toBe(String.raw`Already \$5.`);
  });

  it("keeps an equation in a line", () => {
    expect(normalizeMath("Here $x^2 + 1$ and $2x = 4$.")).toBe("Here $x^2 + 1$ and $2x = 4$.");
    expect(normalizeMath("Pay $5 for $n$ items.")).toBe(String.raw`Pay \$5 for $n$ items.`);
  });

  it("changes the backslash delimiters", () => {
    expect(normalizeMath(String.raw`Here \( a + b \) is.`)).toBe("Here $a + b$ is.");
    expect(normalizeMath("Then:\n\\[\nE = mc^2\n\\]\nEnd.")).toBe("Then:\n$$\nE = mc^2\n$$\nEnd.");
    expect(normalizeMath(String.raw`\[ E = mc^2 \]`)).toBe("$$\nE = mc^2\n$$");
    expect(normalizeMath("- Item:\n  \\[ a \\]")).toBe("- Item:\n  $$\n  a\n  $$");
  });

  it("makes a fence from $$...$$ on its own line", () => {
    expect(normalizeMath("$$E = mc^2$$")).toBe("$$\nE = mc^2\n$$");
    expect(normalizeMath("$$\nE = mc^2\n$$")).toBe("$$\nE = mc^2\n$$");
    expect(normalizeMath("So $$a$$ holds.")).toBe("So $$a$$ holds.");
  });

  it("does not change code", () => {
    const fence = "```sh\necho $HOME \\( $5 \\)\n```";
    expect(normalizeMath(fence)).toBe(fence);
    expect(normalizeMath("Run `echo $HOME` for $5.")).toBe("Run `echo $HOME` for \\$5.");
  });

  it("gives the same text on a second run", () => {
    const text = "Pay $5. Here \\(a\\) and $b$.\n\n\\[ c \\]\n\n$$d$$";
    expect(normalizeMath(normalizeMath(text))).toBe(normalizeMath(text));
  });
});

describe("Markdown equations", () => {
  it("shows an equation in a line and a display equation", () => {
    const out = html("Mass and energy: $E = mc^2$ and \\(a^2\\).\n\nThen:\n\\[\n\\int_0^1 x\\,dx = \\frac{1}{2}\n\\]");
    expect(count(out, 'class="katex"')).toBe(3);
    expect(count(out, 'class="katex-display"')).toBe(1);
    expect(out).not.toContain("katex-error");
  });

  it("shows money as text", () => {
    const out = html("It costs $5 and $10.");
    expect(out).toContain("It costs $5 and $10.");
    expect(out).not.toContain("katex");
  });

  it("shows a table in a scroll box", () => {
    const out = html("| A | B |\n|---|---|\n| 1 | $x^2$ |");
    expect(out).toContain('<div class="md-table"><table>');
    expect(count(out, 'class="katex"')).toBe(1);
  });

  it("shows the source of an equation with an error", () => {
    const out = html("Bad: $\\frac{1$ end.");
    expect(out).toContain("katex-error");
    expect(out).toContain("color:var(--text-muted)");
  });
});
