import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { restorePrefs } from "./lib/prefs";
import { initTheme } from "./lib/theme";

async function start() {
  // The saved app settings go back into localStorage before the app reads them (lib/prefs.ts).
  await restorePrefs();
  initTheme(); // Before the first paint: no flash of the other theme.
  // The app loads after the restore, so no module reads a setting too early.
  const [{ default: App }, { Tooltips }] = await Promise.all([import("./App"), import("./components/Tooltips")]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
      <Tooltips />
    </StrictMode>,
  );
}

void start();
