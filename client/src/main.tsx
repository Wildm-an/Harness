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

/** The class "app-inactive" on the root while the window is not in front: decorative animations stop. */
function trackActivity() {
  const update = () => document.documentElement.classList.toggle("app-inactive", document.hidden || !document.hasFocus());
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
}

async function start() {
  trackActivity();
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
