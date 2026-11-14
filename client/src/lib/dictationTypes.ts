// The messages between the app and the speech engine (dictation.worker.ts). This file imports nothing: the
// worker has no window, so it must not load the modules of the app.

/** The Whisper model of the speech engine. With a GPU, its files are about 95 MB (fp16 encoder, q8 decoder). With no GPU, 77 MB (q8). */
export const SPEECH_MODEL = "onnx-community/whisper-base";

export type WorkerRequest =
  | { type: "load"; id: string }
  | { type: "transcribe"; id: string; audio: Float32Array; language: string | null };
export type WorkerReply =
  | { type: "download"; loaded: number; total: number }
  | { type: "ready"; id: string }
  | { type: "text"; id: string; text: string }
  | { type: "error"; id: string; message: string };
