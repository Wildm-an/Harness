import { useEffect, useState } from "react";
import { isTauri } from "../lib/tauri";

// On Windows the app window has no system title bar (tauri.windows.conf.json). The top bar
// of the app is the title bar, and these buttons replace the system buttons.

export function hasWindowControls(): boolean {
  return isTauri() && navigator.userAgent.includes("Windows");
}

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let closed = false;
    void appWindow().then(async (w) => {
      const update = () => void w.isMaximized().then(setMaximized);
      update();
      const unlisten = await w.onResized(update);
      if (closed) unlisten();
      else stop = unlisten;
    });
    return () => {
      closed = true;
      stop?.();
    };
  }, []);

  return (
    // The window buttons show the system tip, as the buttons of other Windows apps do.
    <div className="window-controls" data-native-tip>
      <button type="button" className="window-btn" aria-label="Minimize" title="Minimize" onClick={() => void appWindow().then((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="window-btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void appWindow().then((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" />
            <rect x=".5" y="2.5" width="7" height="7" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button type="button" className="window-btn window-close" aria-label="Close" title="Close" onClick={() => void appWindow().then((w) => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
