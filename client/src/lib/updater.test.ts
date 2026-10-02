import { describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn: the test runner reports an error that a vi.fn throws, also when the
// code catches it.
let check: () => Promise<unknown> = async () => null;
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));

const { availableVersion, checkForUpdate, getUpdateState } = await import("./updater");

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
