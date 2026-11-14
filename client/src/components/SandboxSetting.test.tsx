import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SandboxStatus } from "../daemon/protocol";
import { SANDBOX_HELP, SANDBOX_LABEL, SandboxSetting, sandboxHelp, sandboxLock } from "./SandboxSetting";
import { errorRoute } from "../lib/errorRoute";

const WINDOWS = "Harness has no sandbox for Windows yet. Commands run with no sandbox.";
const off: SandboxStatus = { state: "off", backend: "seatbelt", reason: "The sandbox is off.", available: true };
const offWindows: SandboxStatus = { state: "off", backend: "windows", reason: WINDOWS, available: false };
const ready: SandboxStatus = { state: "ready", backend: "bubblewrap", reason: "Commands run in the sandbox.", available: true };
const unavailable: SandboxStatus = { state: "unavailable", backend: "windows", reason: WINDOWS, available: false };

const render = (status: SandboxStatus | null, disabled = false) =>
  renderToStaticMarkup(<SandboxSetting status={status} disabled={disabled} onSet={() => undefined} />);

describe('the "Local sandbox" row (UI_RULES 9.3, R5)', () => {
  it("has the label of the Claude app", () => {
    expect(SANDBOX_LABEL).toBe("Local sandbox");
    expect(render(off)).toContain('aria-label="Local sandbox"');
  });

  it("shows the state of the daemon computer", () => {
    expect(sandboxHelp(off)).toBe(SANDBOX_HELP);
    expect(sandboxHelp(ready)).toBe(`${SANDBOX_HELP} Ready (bubblewrap): Commands run in the sandbox.`);
    expect(sandboxHelp(unavailable)).toBe(`${SANDBOX_HELP} Not available: ${WINDOWS}`);
    expect(sandboxHelp(offWindows)).toBe(`${SANDBOX_HELP} Not available: ${WINDOWS}`);
    expect(sandboxHelp(null)).toBe(SANDBOX_HELP);
  });

  it("turns the switch on for ready and unavailable, and off for off", () => {
    expect(render(ready)).toContain('aria-checked="true"');
    expect(render(unavailable)).toContain('aria-checked="true"');
    expect(render(off)).toContain('aria-checked="false"');
  });

  it("locks the switch with the reason when the system has no backend", () => {
    expect(sandboxLock(offWindows)).toBe(WINDOWS);
    const html = render(offWindows);
    expect(html).toContain(`title="${WINDOWS}"`);
    expect(html).toMatch(/role="switch"[^>]*disabled=""/);
    // A sandbox that is on can always turn off, also on Windows.
    expect(sandboxLock(off)).toBeNull();
    expect(render(unavailable)).not.toMatch(/role="switch"[^>]*disabled=""/);
  });

  it("is disabled with no connection and with an older daemon", () => {
    expect(render(off, true)).toMatch(/role="switch"[^>]*disabled=""/);
    expect(render(null)).toMatch(/role="switch"[^>]*disabled=""/);
    expect(sandboxLock(null)).toContain("Update the daemon");
  });

  it("shows a failed save next to the General settings", () => {
    expect(errorRoute("sandbox.set")).toBe("view");
  });
});
