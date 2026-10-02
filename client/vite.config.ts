import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev server port. It fails if the port is not available.
export default defineConfig({
  plugins: [react()],
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
