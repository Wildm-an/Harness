import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import App from "./App";
import { Tooltips } from "./components/Tooltips";
import { initTheme } from "./lib/theme";

initTheme(); // Before the first paint: no flash of the other theme.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Tooltips />
  </StrictMode>,
);
