// A block of code in the chat, in the code theme of Settings > Appearance (the theme of the editor):
// the colors of the theme, and the syntax colors of Monaco. The tool rows use it for the commands
// that the agent runs, the files that it writes, and the output (the user asked for this).
// Monaco loads on the first block. Until then, and for a long text, the block has only the theme colors.

import { memo, useEffect, useState } from "react";
import { codeTheme, onThemeChange } from "../lib/theme";

// The background and the text color of each code theme (the Monaco themes, lib/monaco.ts).
const THEME_COLORS: Record<string, { bg: string; fg: string; border?: string }> = {
  vs: { bg: "#fffffe", fg: "#000000" },
  "vs-dark": { bg: "#1e1e1e", fg: "#d4d4d4" },
  "hc-black": { bg: "#000000", fg: "#ffffff", border: "#6fc3df" },
  "hc-light": { bg: "#ffffff", fg: "#292929", border: "#0f4a85" },
  "harness-dark": { bg: "#0b1222", fg: "#f8fafc" },
  "harness-light": { bg: "#ffffff", fg: "#0f172a" },
};

const COLORIZE_LIMIT = 20_000; // Characters. A longer text shows with the theme colors only.

/** The colors of a code theme. An unknown theme gets the colors of Visual Studio dark. */
export function codeColors(theme: string): { bg: string; fg: string; border?: string } {
  return THEME_COLORS[theme] ?? THEME_COLORS["vs-dark"];
}

function useCodeTheme(): string {
  const [theme, setTheme] = useState(codeTheme);
  useEffect(() => onThemeChange(() => setTheme(codeTheme())), []);
  return theme;
}

export const CodeBlock = memo(function CodeBlock({ text, language, path, className }: {
  text: string;
  language?: string; // A Monaco language id, for example "shell" or "json".
  path?: string; // With no language: the language of this file name. Neither: plain text.
  className?: string;
}) {
  const theme = useCodeTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if ((!language && !path) || text.length > COLORIZE_LIMIT) return;
    let live = true;
    void import("../lib/monaco")
      .then(async ({ monaco, languageFor }) => {
        const lang = language ?? (path ? languageFor(path) : undefined);
        if (!lang || !live) return;
        monaco.editor.setTheme(theme); // The token colors (.mtk classes) are the colors of this theme.
        const colored = await monaco.editor.colorize(text, lang, { tabSize: 2 });
        if (live) setHtml(colored);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [text, language, path, theme]);

  const colors = codeColors(theme);
  const style = { background: colors.bg, color: colors.fg, borderColor: colors.border } as React.CSSProperties;
  return html ? (
    <pre className={`code-block ${className ?? ""}`} style={style} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className={`code-block ${className ?? ""}`} style={style}>
      {text}
    </pre>
  );
});
