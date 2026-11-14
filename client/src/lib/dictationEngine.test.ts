import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, DaemonMessage } from "../daemon/protocol";
import { cleanDictation, formatDuration, isSilent, languageName, SAMPLE_RATE, soundLevel, speechText, type CleanupConnection } from "./dictationEngine";
import { cleanupChoices } from "../components/DictationSettings";
import { isDictationKey, pushTarget } from "../components/DictationButton";
import { nextLevels, WAVE_BARS } from "../components/DictationWave";

describe("the text of the speech engine", () => {
  it("drops the noise labels of Whisper", () => {
    expect(speechText(" Fix the bug. ")).toBe("Fix the bug.");
    expect(speechText("[BLANK_AUDIO]")).toBe("");
    expect(speechText(" [Music] (coughing) ")).toBe("");
    expect(speechText("Run [BLANK_AUDIO] the tests.")).toBe("Run the tests.");
  });

  it("keeps short real speech", () => {
    expect(speechText("Thank you.")).toBe("Thank you.");
    expect(speechText("Yes")).toBe("Yes");
  });
});

describe("the audio", () => {
  it("finds silence: too short or too quiet", () => {
    expect(isSilent(new Float32Array(SAMPLE_RATE * 0.2).fill(0.5))).toBe(true);
    expect(isSilent(new Float32Array(SAMPLE_RATE))).toBe(true);
    const speech = new Float32Array(SAMPLE_RATE);
    speech[100] = 0.2;
    expect(isSilent(speech)).toBe(false);
  });

  it("measures the sound level", () => {
    expect(soundLevel(new Float32Array(100))).toBe(0);
    expect(soundLevel(new Float32Array(100).fill(1))).toBe(1);
    const quiet = soundLevel(new Float32Array(100).fill(0.01));
    expect(quiet).toBeGreaterThan(0.1);
    expect(quiet).toBeLessThan(0.4);
  });

  it("moves the bars of the sound wave to the left", () => {
    const start = Array(WAVE_BARS).fill(0);
    const next = nextLevels(start, 0.5);
    expect(next).toHaveLength(WAVE_BARS);
    expect(next[WAVE_BARS - 1]).toBe(0.5);
    expect(nextLevels(next, 0.2).slice(-2)).toEqual([0.5, 0.2]);
  });

  it("shows the time of a recording", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(languageName("de")).toBe("German");
    expect(languageName("")).toBe("Auto");
  });
});

/** A connection that answers each "dictation.cleanup" with ``reply``. */
function fakeConnection(reply: (msg: Extract<ClientMessage, { type: "dictation.cleanup" }>) => DaemonMessage | null, status = "open") {
  const listeners = new Set<(msg: DaemonMessage) => void>();
  const sent: ClientMessage[] = [];
  const conn: CleanupConnection = {
    status,
    send: (msg) => {
      sent.push(msg);
      if (msg.type !== "dictation.cleanup") return;
      const answer = reply(msg);
      if (answer) queueMicrotask(() => listeners.forEach((fn) => fn(answer)));
    },
    onMessage: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { conn, sent, listeners };
}

describe("the cleanup request", () => {
  afterEach(() => vi.useRealTimers());

  it("gives the text of the model", async () => {
    const { conn, sent, listeners } = fakeConnection((m) => ({ type: "dictation.cleaned", id: m.id, text: "Fix app.tsx.", cleaned: true }));
    await expect(cleanDictation(conn, "um fix app dot tsx")).resolves.toEqual({ text: "Fix app.tsx." });
    expect(sent[0]).toMatchObject({ type: "dictation.cleanup", text: "um fix app dot tsx" });
    expect(listeners.size).toBe(0); // The listener stops after the reply.
  });

  it("keeps the raw text with the error of the daemon", async () => {
    const { conn } = fakeConnection((m) => ({ type: "dictation.cleaned", id: m.id, text: "um hi", cleaned: false, error: "No cleanup model is set." }));
    await expect(cleanDictation(conn, "um hi")).resolves.toEqual({ text: "um hi", error: "No cleanup model is set." });
    const failed = fakeConnection(() => ({ type: "error", message: "'text' must be a string.", ref: "dictation.cleanup" }));
    await expect(cleanDictation(failed.conn, "um hi")).resolves.toEqual({ text: "um hi", error: "'text' must be a string." });
  });

  it("ignores the reply of another request", async () => {
    vi.useFakeTimers();
    const { conn } = fakeConnection(() => ({ type: "dictation.cleaned", id: "other", text: "No.", cleaned: true }));
    const result = cleanDictation(conn, "hello", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ text: "hello", error: "The daemon did not answer." });
  });

  it("keeps the text with no connection", async () => {
    const { conn, sent } = fakeConnection(() => null, "closed");
    await expect(cleanDictation(conn, "hello")).resolves.toEqual({ text: "hello", error: "The app is not connected to the daemon." });
    expect(sent).toHaveLength(0);
  });
});

describe("the settings and the key", () => {
  it("splits the cleanup models into providers and local models", () => {
    const providers = [
      { name: "anthropic", base_url: "https://api.anthropic.com/v1", ssh: null },
      { name: "ollama", base_url: "http://localhost:11434/v1", ssh: null },
    ] as unknown as Parameters<typeof cleanupChoices>[1];
    expect(cleanupChoices(["anthropic/claude-haiku-5-5", "ollama/qwen3"], providers)).toEqual({
      online: ["anthropic/claude-haiku-5-5"],
      local: ["ollama/qwen3"],
    });
  });

  it("gives push to talk to the box with the newest focus that is not disabled", () => {
    const box = (name: string, activeAt: number, disabled = false) => ({ name, activeAt, disabled: () => disabled });
    expect(pushTarget([box("session", 10), box("side chat", 30), box("split", 20)])?.name).toBe("side chat");
    expect(pushTarget([box("session", 10), box("side chat", 30, true)])?.name).toBe("session");
    expect(pushTarget([box("a", 5), box("b", 5)])?.name).toBe("b"); // The same time: the newer box.
    expect(pushTarget([])).toBeNull();
  });

  it("knows the key of dictation", () => {
    const key = { code: "Space", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
    expect(isDictationKey(key)).toBe(true);
    expect(isDictationKey({ ...key, shiftKey: false })).toBe(false);
    expect(isDictationKey({ ...key, altKey: true })).toBe(false);
  });
});
