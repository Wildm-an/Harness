// Dictation: the microphone, the speech engine (Whisper in dictation.worker.ts), and the cleanup model.
//
// The speech engine runs on this computer and needs no settings: the user can always dictate. When the user
// turns on "Clean up dictation" (Settings > General > Dictation), the daemon sends the raw text to the chosen
// model of a provider or a local model ("dictation.cleanup"), and the prompt box gets the clean text.
// The menu of the microphone button keeps its choices on this device: the microphone, the language, and
// "Hold to record".

import type { ClientMessage, DaemonMessage } from "../daemon/protocol";
import { loadPref, savePref } from "./prefs";
import { SPEECH_MODEL, type WorkerReply, type WorkerRequest } from "./dictationTypes";

export { SPEECH_MODEL };

export const SPEECH_MODEL_LABEL = "Whisper base";
export const SAMPLE_RATE = 16_000; // Whisper reads 16 kHz mono audio.
export const MAX_RECORD_MS = 10 * 60_000; // A recording stops after 10 minutes.
/** A press of the microphone button shorter than this is a click: the recording continues until the next click. */
export const HOLD_MS = 350;


// -- the choices of the microphone menu (per device) ---------------------------------------------------

const MIC_PREF = "dictation.microphone";
const LANGUAGE_PREF = "dictation.language";
const HOLD_PREF = "dictation.hold";
const PUSH_PREF = "dictation.push";

/** The languages of the "Language" submenu: a Whisper language code and its name. "" is "Auto". */
export const LANGUAGES: [string, string][] = [
  ["", "Auto"],
  ["en", "English"],
  ["ar", "Arabic"],
  ["zh", "Chinese"],
  ["cs", "Czech"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["de", "German"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["hu", "Hungarian"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["no", "Norwegian"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["es", "Spanish"],
  ["sv", "Swedish"],
  ["th", "Thai"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["vi", "Vietnamese"],
];

export function languageName(code: string): string {
  return LANGUAGES.find(([c]) => c === code)?.[1] ?? "Auto";
}

/** The microphone of the menu. "default": the default microphone of the system. */
export function savedMicrophone(): string {
  return loadPref(MIC_PREF, "default");
}
export function saveMicrophone(id: string): void {
  savePref(MIC_PREF, id);
}
/** The language of the speech. "": Whisper finds the language. */
export function savedLanguage(): string {
  const code = loadPref(LANGUAGE_PREF, "");
  return LANGUAGES.some(([c]) => c === code) ? code : "";
}
export function saveLanguage(code: string): void {
  savePref(LANGUAGE_PREF, code);
}
/** "Hold to record": on (the default), a press of the button records until the release. A click still starts and stops. */
export function savedHold(): boolean {
  return loadPref(HOLD_PREF, "on") !== "off";
}
export function saveHold(on: boolean): void {
  savePref(HOLD_PREF, on ? "on" : "off");
}
/** "Push to talk" (off by default): the key records while it is down, from any place in the window, and stops at the release. */
export function savedPushToTalk(): boolean {
  return loadPref(PUSH_PREF, "off") === "on";
}
export function savePushToTalk(on: boolean): void {
  savePref(PUSH_PREF, on ? "on" : "off");
}

// -- the microphones -----------------------------------------------------------------------------------

export interface Microphone {
  id: string;
  label: string;
}

/** The microphones of the system. The labels are empty until the user allows the microphone: then the app asks
 * for it one time (the system shows its question), and stops it at once. */
export async function listMicrophones(): Promise<Microphone[]> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) return [];
  let devices = (await media.enumerateDevices()).filter((d) => d.kind === "audioinput");
  if (devices.length > 0 && devices.every((d) => !d.label)) {
    try {
      const stream = await media.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devices = (await media.enumerateDevices()).filter((d) => d.kind === "audioinput");
    } catch {
      // No permission: the list shows the devices with plain names.
    }
  }
  return devices.map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === "default" ? "Default microphone" : `Microphone ${i + 1}`) }));
}

/** The text of a microphone error for the user. */
export function microphoneError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Harness cannot use the microphone. Allow microphone access for Harness in the privacy settings of the system, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone is connected. Connect one, or choose another microphone in the menu of the microphone button.";
  if (name === "NotReadableError") return "The microphone is in use by another app, or the system stopped it.";
  return `The microphone did not start: ${e instanceof Error ? e.message : String(e)}`;
}

// -- the recording -------------------------------------------------------------------------------------

/**
 * One recording of the microphone. The recording keeps the raw samples, so the live text can read the audio
 * while the user talks (``audio``), and ``stop`` gives all of it. The audio for Whisper is 16 kHz mono.
 */
export class Recording {
  private chunks: Float32Array[] = [];
  private length = 0; // Samples at the rate of the context.
  private source: MediaStreamAudioSourceNode;
  private node: ScriptProcessorNode;
  private closed = false;
  readonly started = Date.now();

  private constructor(
    private stream: MediaStream,
    private context: AudioContext,
  ) {
    this.source = context.createMediaStreamSource(stream);
    // A script processor has the same result in each web view (WebView2, WebKit). Its output stays silent.
    this.node = context.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      if (this.closed) return;
      const samples = new Float32Array(e.inputBuffer.getChannelData(0));
      this.chunks.push(samples);
      this.length += samples.length;
      const level = soundLevel(samples);
      levelListeners.forEach((fn) => fn(level));
    };
    this.source.connect(this.node);
    this.node.connect(context.destination);
  }

  /** Starts the microphone. The saved microphone, else the default microphone when the saved one is gone. */
  static async start(deviceId: string): Promise<Recording> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia || typeof AudioContext === "undefined") throw new Error("This window cannot record audio.");
    // Make the context before the first await: it then counts as a part of the click, and it can start.
    const context = new AudioContext();
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    let stream: MediaStream;
    try {
      try {
        stream = await media.getUserMedia({ audio: deviceId && deviceId !== "default" ? { ...audio, deviceId: { exact: deviceId } } : audio });
      } catch (e) {
        if (!(e instanceof DOMException) || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError") || deviceId === "default") throw e;
        stream = await media.getUserMedia({ audio });
      }
      await context.resume();
    } catch (e) {
      void context.close();
      throw e;
    }
    return new Recording(stream, context);
  }

  /** The seconds of audio so far. */
  get seconds(): number {
    return this.length / this.context.sampleRate;
  }

  /** The audio from ``fromSeconds`` to now, as 16 kHz mono samples. */
  audio(fromSeconds = 0): Promise<Float32Array> {
    const from = Math.max(0, Math.floor(fromSeconds * this.context.sampleRate));
    const out = new Float32Array(Math.max(0, this.length - from));
    let at = 0; // The index of the first sample of the chunk in the recording.
    for (const chunk of this.chunks) {
      const end = at + chunk.length;
      if (end > from) out.set(chunk.subarray(Math.max(0, from - at)), Math.max(0, at - from));
      at = end;
    }
    return resample(out, this.context.sampleRate);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.getTracks().forEach((t) => t.stop());
    this.source.disconnect();
    this.node.disconnect();
    void this.context.close();
  }

  /** Stops the microphone and gives all the audio. */
  stop(): Promise<Float32Array> {
    this.close();
    return this.audio(0);
  }

  /** Stops the microphone and drops the audio. */
  cancel(): void {
    this.close();
    this.chunks = [];
    this.length = 0;
  }
}

const levelListeners = new Set<(level: number) => void>();

/** Calls ``fn`` with the sound level of the microphone (0 to 1), about 10 times each second while it records. */
export function onSoundLevel(fn: (level: number) => void): () => void {
  levelListeners.add(fn);
  return () => levelListeners.delete(fn);
}

/** The sound level of samples, from 0 (silence) to 1 (loud speech). The square root makes quiet speech visible. */
export function soundLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 2.2);
}

/** Changes mono samples at ``rate`` to 16 kHz, with the resampler of the web view. */
export async function resample(samples: Float32Array<ArrayBuffer>, rate: number): Promise<Float32Array> {
  if (rate === SAMPLE_RATE || samples.length === 0) return samples;
  const frames = Math.max(1, Math.ceil((samples.length * SAMPLE_RATE) / rate));
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const buffer = offline.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

/** True when the audio has no speech: too short, or too quiet. Whisper then writes words that nobody said. */
export function isSilent(audio: Float32Array): boolean {
  if (audio.length < SAMPLE_RATE * 0.3) return true;
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  return peak < 0.01;
}

/** Whisper writes a label in brackets for noise, for example "[Music]" or "(coughing)". It is not speech. */
const NOT_SPEECH = /^[\s.]*((\[[^\]]*\]|\([^)]*\))\s*)*[\s.]*$/;

/** The text of Whisper with no noise labels ("[BLANK_AUDIO]", "(music)"). Empty when it has no speech. */
export function speechText(raw: string): string {
  const text = raw.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]/gi, " ").replace(/\s+/g, " ").trim();
  return NOT_SPEECH.test(text) ? "" : text;
}

// -- the speech engine ---------------------------------------------------------------------------------

/** The download of the speech model: the bytes so far and in total. */
export type DownloadProgress = { loaded: number; total: number };
type Waiter = { resolve: (text: string) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
const waiters = new Map<string, Waiter>();
const downloadListeners = new Set<(p: DownloadProgress) => void>();
let nextId = 0;

function engine(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./dictation.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerReply>) => {
    const msg = event.data;
    if (msg.type === "download") {
      downloadListeners.forEach((fn) => fn({ loaded: msg.loaded, total: msg.total }));
      return;
    }
    const waiter = waiters.get(msg.id);
    if (!waiter) return;
    waiters.delete(msg.id);
    if (msg.type === "error") waiter.reject(new Error(msg.message));
    else waiter.resolve(msg.type === "text" ? msg.text : "");
  };
  w.onerror = (e) => {
    // The worker did not start: each waiting request fails, and the next request starts a new worker.
    for (const waiter of waiters.values()) waiter.reject(new Error(e.message || "The speech engine did not start."));
    waiters.clear();
    w.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

function ask(request: Omit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<string> {
  const id = `d${++nextId}`;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    engine().postMessage({ ...request, id }, transfer);
  });
}

/** Calls ``fn`` with the download progress of the speech model. Returns the function that stops it. */
export function onSpeechDownload(fn: (p: DownloadProgress) => void): () => void {
  downloadListeners.add(fn);
  return () => downloadListeners.delete(fn);
}

/** Loads the speech model: the first time, it downloads the model. */
export function loadSpeechModel(): Promise<void> {
  return ask({ type: "load" }).then(() => undefined);
}

/** The text of the speech in the audio. */
export async function transcribe(audio: Float32Array, language: string | null): Promise<string> {
  if (isSilent(audio)) return "";
  return speechText(await ask({ type: "transcribe", audio, language } as Omit<WorkerRequest, "id">, [audio.buffer]));
}

/** True when the files of the speech model are in the cache of this device. */
export async function speechModelCached(): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    const files = keys.map((r) => r.url).filter((u) => u.includes(SPEECH_MODEL));
    return files.some((u) => u.includes("encoder_model")) && files.some((u) => u.includes("decoder_model"));
  } catch {
    return false;
  }
}

/** Deletes the speech model from the cache of this device. The next dictation downloads it again. */
export async function deleteSpeechModel(): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open("transformers-cache");
  for (const request of await cache.keys()) if (request.url.includes(SPEECH_MODEL)) await cache.delete(request);
  worker?.terminate();
  worker = null;
}

// -- the cleanup model and the errors (the app gives them: they need the daemon connection) ---------------

export interface DictationHost {
  /** True when "Clean up dictation" is on. Off: the prompt box gets the text of the speech engine as it is. */
  cleanupOn: () => boolean;
  /** Asks the daemon to clean the text. It gives the text to use, and an error when the cleanup failed. */
  clean: (text: string) => Promise<{ text: string; error?: string }>;
  /** Shows an error popup. */
  showError: (text: string) => void;
}

let host: DictationHost | null = null;

export function setDictationHost(next: DictationHost | null): void {
  host = next;
}

export function dictationHost(): DictationHost | null {
  return host;
}

/** The part of the daemon connection that the cleanup uses. */
export interface CleanupConnection {
  status: string;
  send: (msg: ClientMessage) => void;
  onMessage: (fn: (msg: DaemonMessage) => void) => () => void;
}

export const CLEANUP_WAIT_MS = 70_000; // The daemon waits 60 seconds for the model.
let cleanupId = 0;

/** Asks the daemon to clean the text ("dictation.cleanup"). With no connection, or with no reply, the text stays as it is. */
export function cleanDictation(conn: CleanupConnection, text: string, waitMs = CLEANUP_WAIT_MS): Promise<{ text: string; error?: string }> {
  if (conn.status !== "open") return Promise.resolve({ text, error: "The app is not connected to the daemon." });
  const id = `clean-${Date.now().toString(36)}-${++cleanupId}`;
  return new Promise((resolve) => {
    const done = (result: { text: string; error?: string }) => {
      clearTimeout(timer);
      stop();
      resolve(result);
    };
    const stop = conn.onMessage((msg) => {
      if (msg.type === "dictation.cleaned" && msg.id === id) {
        const cleaned = msg.text.trim() ? msg.text : text;
        done(msg.error ? { text: cleaned, error: msg.error } : { text: cleaned });
      } else if (msg.type === "error" && msg.ref === "dictation.cleanup") {
        done({ text, error: msg.message });
      }
    });
    const timer = setTimeout(() => done({ text, error: "The daemon did not answer." }), waitMs);
    conn.send({ type: "dictation.cleanup", id, text });
  });
}

/** "1:05" for 65 seconds. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
