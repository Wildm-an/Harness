import { describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn: the test runner reports an error that a vi.fn throws, also when the
// code catches it.
let check: () => Promise<unknown> = async () => null;
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("./tauri", () => ({ isTauri: () => true }));
let relaunched = 0;
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => void (relaunched += 1) }));

const { availableVersion, checkAtStart, checkForUpdate, checkOnLaunch, getUpdateState, installUpdate, setCheckAtStart } =
  await import("./updater");
const { updateToastView } = await import("../components/UpdateToast");

describe("the update check", () => {
  it("finds a new version", async () => {
    check = async () => ({ version: "0.2.0" });
    await checkForUpdate(true);
    expect(getUpdateState().kind).toBe("available");
    expect(availableVersion(getUpdateState())).toBe("0.2.0");
  });

  it("shows no error for the quiet check at launch", async () => {
    check = async () => {
      throw new Error("EmptyEndpoints");
    };
    await checkForUpdate(true);
    expect(getUpdateState()).toEqual({ kind: "idle" });
  });

  it("explains a missing update address when the user asks", async () => {
    check = async () => {
      throw new Error("the updater has no endpoints");
    };
    await checkForUpdate();
    const state = getUpdateState();
    expect(state.kind === "error" && state.message).toContain("no update address yet");
  });

  it("explains that no release is published yet", async () => {
    check = async () => {
      throw new Error("Could not fetch a valid release JSON from the remote");
    };
    await checkForUpdate();
    const state = getUpdateState();
    expect(state.kind === "error" && state.message).toContain("No published release");
  });

  it("knows the newest version", async () => {
    check = async () => null;
    await checkForUpdate(true);
    expect(getUpdateState()).toEqual({ kind: "none" });
    expect(availableVersion(getUpdateState())).toBeNull();
  });
});

describe("the check at start", () => {
  it("is on by default, and the setting turns it off", async () => {
    // The tests run in Node: a window with a small localStorage.
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    });
    vi.stubGlobal("window", globalThis);
    expect(checkAtStart()).toBe(true);
    setCheckAtStart(false);
    expect(checkAtStart()).toBe(false);

    vi.useFakeTimers();
    let calls = 0;
    check = async () => {
      calls += 1;
      return null;
    };
    checkOnLaunch();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);

    setCheckAtStart(true);
    checkOnLaunch();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe("the install", () => {
  type Event = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };

  // The failure goes first: after the mocked relaunch, the state stays "installing".
  it("reports a failed download", async () => {
    check = async () => ({
      version: "0.3.1",
      downloadAndInstall: async () => {
        throw new Error("network down");
      },
    });
    await checkForUpdate(true);
    await installUpdate();
    const state = getUpdateState();
    expect(state.kind === "error" && state.message).toBe("The update did not install: network down");
  });

  it("shows the download percent, then the install step, then starts the app again", async () => {
    const seen: unknown[] = [];
    check = async () => ({
      version: "0.3.0",
      downloadAndInstall: async (onEvent: (e: Event) => void) => {
        onEvent({ event: "Started", data: { contentLength: 200 } });
        seen.push(getUpdateState());
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
        seen.push(getUpdateState());
        onEvent({ event: "Progress", data: { chunkLength: 150 } });
        seen.push(getUpdateState());
        onEvent({ event: "Finished" });
        seen.push(getUpdateState());
      },
    });
    await checkForUpdate(true);
    expect(updateToastView(getUpdateState(), null)).toEqual({ kind: "offer", version: "0.3.0" });
    relaunched = 0;
    await installUpdate();
    expect(seen).toEqual([
      { kind: "installing", version: "0.3.0", step: "download", percent: null },
      { kind: "installing", version: "0.3.0", step: "download", percent: 25 },
      { kind: "installing", version: "0.3.0", step: "download", percent: 100 },
      { kind: "installing", version: "0.3.0", step: "install", percent: 100 },
    ]);
    expect(relaunched).toBe(1);
  });

});

describe("the update popup", () => {
  it("shows the offer, the progress, the install step, and the error of its own install", () => {
    const installing = (step: "download" | "install", percent: number | null) =>
      ({ kind: "installing", version: "0.3.0", step, percent }) as const;
    expect(updateToastView(installing("download", null), "0.3.0")).toEqual({ kind: "download", version: "0.3.0", percent: null });
    expect(updateToastView(installing("download", 42), null)).toEqual({ kind: "download", version: "0.3.0", percent: 42 });
    expect(updateToastView(installing("install", 100), "0.3.0")).toEqual({ kind: "install", version: "0.3.0" });
    const error = { kind: "error", message: "The update did not install: x" } as const;
    expect(updateToastView(error, "0.3.0")).toEqual({ kind: "error", version: "0.3.0", message: error.message });
    // An error of a check or an install from Settings does not show in the popup.
    expect(updateToastView(error, null)).toBeNull();
    expect(updateToastView({ kind: "none" }, null)).toBeNull();
    expect(updateToastView({ kind: "checking" }, null)).toBeNull();
  });
});
