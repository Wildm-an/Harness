import { describe, expect, it, vi } from "vitest";

// The desktop app and the notification plugin, mocked: the test reads what the app sends.
const sent: unknown[] = [];
vi.mock("./tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (options: unknown) => void sent.push(options),
}));

const { notifyRoutineRun, notifyTurnDone } = await import("./notify");

describe("a click on a notification", () => {
  it("can open the session: each notification has its session id", async () => {
    await notifyTurnDone(
      { session_id: "s7", title: "Fix the login bug", summary: "Done.", stop_reason: "end" },
      { windowVisible: false, windowFocused: false, shownSessionId: null },
    );
    await notifyRoutineRun({ name: "Daily", status: "done", session_id: "s8" }, { windowVisible: false, shownSessionId: null });
    expect(sent).toEqual([
      { title: "Fix the login bug", body: "Done.", extra: { session_id: "s7" } },
      { title: "Daily finished", extra: { session_id: "s8" } },
    ]);
  });
});
