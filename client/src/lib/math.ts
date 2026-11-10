/**
 * Equations in chat Markdown. The parser (remark-math) reads `$...$` and a `$$` fence. Models also write
 * `\(...\)`, `\[...\]`, and `$$...$$` on one line, and they write `$` for money. `normalizeMath` changes
 * the text to the forms that the parser reads, and it escapes each `$` that does not start an equation.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Changes the equation delimiters in Markdown text. Code fences and code spans stay as they are. */
export function normalizeMath(text: string): string {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length) out.push(normalizeProse(prose.join("\n")));
    prose = [];
  };
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (m && m[1][0] === fence) fence = null;
    } else if (m) {
      flush();
      fence = m[1][0];
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** The index of the end of the paragraph that holds `from`: the next blank line, or the end of the text. */
function paragraphEnd(s: string, from: number): number {
  const m = /\n[ \t]*\n/.exec(s.slice(from));
  return m ? from + m.index : s.length;
}

function normalizeProse(s: string): string {
  let out = "";
  let i = 0;
  /** True when only spaces are before position `out.length` and after position `end` on their lines. */
  const alone = (end: number) => {
    const before = out.slice(out.lastIndexOf("\n") + 1);
    const nl = s.indexOf("\n", end);
    const after = s.slice(end, nl < 0 ? s.length : nl);
    return before.trim() === "" && after.trim() === "";
  };
  /** A display equation. On its own lines it is a `$$` fence, else it stays in the line. */
  const display = (body: string, end: number) => {
    if (alone(end)) {
      const indent = out.slice(out.lastIndexOf("\n") + 1);
      out += `$$\n${indent}${body.trim()}\n${indent}$$`;
    } else {
      out += `$$${body.replace(/\s*\n\s*/g, " ").trim()}$$`;
    }
    i = end;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      // A code span: copy to the closing run of the same length.
      let run = 1;
      while (s[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      let close = s.indexOf(ticks, i + run);
      while (close >= 0 && (s[close + run] === "`" || s[close - 1] === "`")) close = s.indexOf(ticks, close + run + 1);
      const end = close < 0 ? i + run : close + run;
      out += s.slice(i, end);
      i = end;
    } else if (c === "\\") {
      const next = s[i + 1];
      const close = next === "[" ? s.indexOf("\\]", i + 2) : next === "(" ? s.indexOf("\\)", i + 2) : -1;
      if (next === "[" && close >= 0) {
        display(s.slice(i + 2, close), close + 2);
      } else if (next === "(" && close >= 0 && close < paragraphEnd(s, i)) {
        out += `$${s.slice(i + 2, close).trim()}$`;
        i = close + 2;
      } else {
        // An escape such as `\$`: copy the two characters.
        out += s.slice(i, i + 2);
        i += 2;
      }
    } else if (c === "$" && s[i + 1] === "$") {
      const close = s.indexOf("$$", i + 2);
      if (close >= 0) {
        display(s.slice(i + 2, close), close + 2);
      } else {
        out += "$$";
        i += 2;
      }
    } else if (c === "$") {
      const close = inlineClose(s, i);
      if (close >= 0) {
        out += s.slice(i, close + 1);
        i = close + 1;
      } else {
        // Money, or a shell variable: not an equation.
        out += "\\$";
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The index of the `$` that closes the equation that starts at `open`, else -1. The rules are those of
 * Pandoc: no space after the first `$`, no space before the last `$`, and no digit after the last `$`.
 * Thus "$5 and $10" has no equation.
 */
function inlineClose(s: string, open: number): number {
  if (isSpace(s[open + 1])) return -1;
  const stop = paragraphEnd(s, open);
  // The parser closes the equation at the next `$`. That `$` must obey the rules.
  const j = s.indexOf("$", open + 1);
  if (j < 0 || j >= stop || j === open + 1) return -1;
  return !isSpace(s[j - 1]) && !isDigit(s[j + 1]) && s[j + 1] !== "$" ? j : -1;
}
