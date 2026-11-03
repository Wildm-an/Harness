import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The data files of pdf.js for the Preview pane: the CMaps, the standard fonts, the image decoders,
// and the ICC profiles. The app serves them at /pdfjs/<folder>/<file>, so a PDF renders offline.
// The Content Security Policy allows "self" only, so a CDN cannot be used.
const PDFJS_DIR = join(__dirname, "node_modules", "pdfjs-dist");
const PDFJS_FOLDERS = ["cmaps", "standard_fonts", "wasm", "iccs"];

function pdfjsAssets(): Plugin {
  const files = (): string[] =>
    PDFJS_FOLDERS.flatMap((folder) =>
      readdirSync(join(PDFJS_DIR, folder))
        .filter((name) => !name.startsWith("LICENSE") && statSync(join(PDFJS_DIR, folder, name)).isFile())
        .map((name) => `${folder}/${name}`),
    );
  const type = (name: string) =>
    name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  return {
    name: "harness-pdfjs-assets",
    configureServer(server) {
      const known = new Set(files());
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0].replace(/^\//, ""));
        if (!known.has(rel)) return next();
        res.setHeader("Content-Type", type(rel));
        res.end(readFileSync(join(PDFJS_DIR, rel)));
      });
    },
    generateBundle() {
      for (const rel of files()) {
        this.emitFile({ type: "asset", fileName: `pdfjs/${rel}`, source: readFileSync(join(PDFJS_DIR, rel)) });
      }
    },
  };
}

// Tauri expects a fixed dev server port. It fails if the port is not available.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
    // The Changelog page imports CHANGELOG.md from the root of the repository.
    // The paths are relative to this folder.
    fs: { allow: [".", "../CHANGELOG.md"] },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
