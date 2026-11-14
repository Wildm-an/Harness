/// <reference lib="webworker" />
// The speech engine of dictation: Whisper base, in this worker, so the window does not stop while it works.
// The first use downloads the model from Hugging Face. The worker keeps it in the Cache API ("transformers-cache"),
// so the next uses work offline. The WebAssembly runtime comes with the app (no CDN).
//
// The encoder does most of the work: it reads 30 seconds of audio each time. With a GPU (WebGPU), it runs there,
// about 4 times faster than on one CPU thread (fp16 when the GPU has 16-bit shaders, else fp32). The decoder runs
// on the CPU (q8). With no GPU, or when the GPU fails, all of Whisper runs on the CPU (q8).

import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { SPEECH_MODEL, type WorkerReply, type WorkerRequest } from "./dictationTypes";

env.allowLocalModels = false;
// The runtime files come from the app itself: no copy in the Cache API, and no blob: script (the CSP allows 'self').
env.useWasmCache = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
if (onnx.wasm) onnx.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href, mjs: new URL(mjsUrl, self.location.href).href };

const post = (msg: WorkerReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

type Encoder = "fp16" | "fp32" | null; // null: no GPU, the CPU runs the encoder.

/** The encoder type for the GPU of this computer, or null with no usable GPU. */
async function gpuEncoder(): Promise<Encoder> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    if (!adapter) return null;
    return adapter.features.has("shader-f16") ? "fp16" : "fp32";
  } catch {
    return null;
  }
}

// The bytes of each model file, for one progress value of all the files.
const files = new Map<string, { loaded: number; total: number }>();
function progress(p: { status: string; file?: string; loaded?: number; total?: number }) {
  if (p.status !== "progress" || !p.file || !p.total) return;
  files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  post({ type: "download", loaded, total });
}

function open(encoder: Encoder): Promise<AutomaticSpeechRecognitionPipeline> {
  return pipeline("automatic-speech-recognition", SPEECH_MODEL, {
    device: encoder ? { encoder_model: "webgpu", decoder_model_merged: "wasm" } : "wasm",
    dtype: encoder ? { encoder_model: encoder, decoder_model_merged: "q8" } : "q8",
    progress_callback: progress,
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
}

let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  loading ??= (async () => {
    const encoder = await gpuEncoder();
    if (encoder) {
      try {
        return await open(encoder);
      } catch (e) {
        console.warn("Whisper did not start on the GPU. It runs on the CPU.", e);
        files.clear();
      }
    }
    return open(null);
  })().catch((e: unknown) => {
    loading = null; // The next try downloads again, for example after the network comes back.
    throw e;
  });
  return loading;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    const asr = await load();
    if (msg.type === "load") {
      post({ type: "ready", id: msg.id });
      return;
    }
    const result = await asr(msg.audio, {
      // Whisper reads 30-second windows. A longer recording goes in parts that overlap by 5 seconds.
      chunk_length_s: 30,
      stride_length_s: 5,
      task: "transcribe",
      ...(msg.language ? { language: msg.language } : {}),
    });
    const text = (Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text).trim();
    post({ type: "text", id: msg.id, text });
  } catch (e) {
    post({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
