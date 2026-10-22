/**
 * On-device speech recognition with OpenAI's open-source Whisper model,
 * run by Hugging Face Transformers.js (Apache-2.0) on ONNX Runtime Web.
 * Audio never leaves the visitor's device: only the model weights are
 * downloaded (once, then cached by the browser), and the ONNX runtime itself
 * is served by Rewind rather than a third-party CDN.
 */
import { env, pipeline } from '@huggingface/transformers';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

const MODEL = 'onnx-community/whisper-tiny.en';

env.allowLocalModels = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: new URL(ortMjs, self.location.origin).href, wasm: new URL(ortWasm, self.location.origin).href };
  // Threads need cross-origin isolation, which the site does not enable; one thread is plenty for short commands.
  onnx.wasm.numThreads = 1;
}

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;

function load(): Promise<Asr> {
  if (!asr) {
    const files = new Map<string, { loaded: number; total: number }>();
    asr = pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          self.postMessage({ type: 'progress', loaded, total });
        }
      },
    }) as unknown as Promise<Asr>;
    asr.catch(() => {
      asr = null;
    });
  }
  return asr;
}

self.onmessage = async (e: MessageEvent<{ type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array }>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load();
      self.postMessage({ type: 'ready' });
      return;
    }
    const run = await load();
    const out = await run(msg.audio, { chunk_length_s: 30 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    self.postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    self.postMessage({ type: 'error', id: 'id' in msg ? msg.id : -1, message: err instanceof Error ? err.message : String(err) });
  }
};
