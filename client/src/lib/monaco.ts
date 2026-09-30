// Monaco setup. The app bundles Monaco: it loads nothing from a CDN, so it works offline and
// inside the Content Security Policy of the desktop app.

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// The editor has no language server (SPEC.md section 11). Without the project types, the
// TypeScript checks would mark each import as an error. Keep only the syntax checks.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

// The colors come from the design tokens in styles.css.
monaco.editor.defineTheme("harness-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0b1222",
    "editor.foreground": "#f8fafc",
    "editorLineNumber.foreground": "#475569",
    "editorLineNumber.activeForeground": "#94a3b8",
    "editor.lineHighlightBackground": "#1e293b80",
    "editor.selectionBackground": "#38bdf840",
    "editorCursor.foreground": "#22c55e",
    "editorGutter.background": "#0b1222",
    "editorWidget.background": "#1e293b",
    "editorWidget.border": "#334155",
    "input.background": "#0f172a",
    "input.border": "#475569",
    "focusBorder": "#38bdf8",
    "scrollbarSlider.background": "#5a5852",
    "scrollbarSlider.hoverBackground": "#6e6c65",
    "scrollbarSlider.activeBackground": "#6e6c65",
    "diffEditor.insertedTextBackground": "#22c55e24",
    "diffEditor.removedTextBackground": "#f8717124",
    "diffEditor.insertedLineBackground": "#22c55e14",
    "diffEditor.removedLineBackground": "#f8717114",
  },
});

monaco.editor.defineTheme("harness-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#0f172a",
    "editorLineNumber.foreground": "#94a3b8",
    "editorLineNumber.activeForeground": "#475569",
    "editor.lineHighlightBackground": "#f1f5f9",
    "editorCursor.foreground": "#15803d",
    "focusBorder": "#0369a1",
  },
});

loader.config({ monaco });

export { monaco };

export function monacoTheme(): string {
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return light ? "harness-light" : "harness-dark";
}

/** The Monaco language for a file path. */
export function languageFor(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
  const found = monaco.languages
    .getLanguages()
    .find((l) => l.extensions?.includes(ext) || l.filenames?.includes(name));
  return found?.id;
}
