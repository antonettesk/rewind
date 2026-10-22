/**
 * Microphone capture for on-device recognition: records mono audio, reports a
 * live level for the light ring, stops by itself after a pause in speech, and
 * resamples to the 16 kHz Whisper expects. Works in every modern browser.
 */

export interface Recording {
  /** Resolves with 16 kHz mono samples, or null if nothing was said. */
  done: Promise<Float32Array | null>;
  stop: () => void;
}

const TARGET_RATE = 16_000;

export async function record(opts: { onLevel?: (level: number) => void; maxMs?: number; silenceMs?: number; noSpeechMs?: number } = {}): Promise<Recording> {
  const maxMs = opts.maxMs ?? 12_000;
  const silenceMs = opts.silenceMs ?? 1_200;
  const noSpeechMs = opts.noSpeechMs ?? 6_000;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally supported and needs no separate worklet file.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const started = performance.now();
  let noiseFloor = 0;
  let floorSamples = 0;
  let heardSpeech = false;
  let lastVoice = started;
  let finished = false;

  let resolve!: (v: Float32Array | null) => void;
  const done = new Promise<Float32Array | null>((r) => (resolve = r));

  const finish = async () => {
    if (finished) return;
    finished = true;
    proc.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    opts.onLevel?.(0);
    const sampleRate = ctx.sampleRate;
    await ctx.close().catch(() => undefined);
    if (!heardSpeech || !chunks.length) return resolve(null);
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(length);
    let at = 0;
    for (const c of chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    resolve(await resample(pcm, sampleRate));
  };

  proc.onaudioprocess = (ev) => {
    if (finished) return;
    const data = ev.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    // Learn the room's noise floor during the first ~300 ms.
    if (now - started < 300) {
      noiseFloor = (noiseFloor * floorSamples + rms) / ++floorSamples;
    }
    const threshold = Math.max(0.012, noiseFloor * 2.5);
    if (rms > threshold) {
      heardSpeech = true;
      lastVoice = now;
    }
    opts.onLevel?.(Math.min(1, rms / Math.max(threshold * 4, 0.08)));
    if (heardSpeech && now - lastVoice > silenceMs) void finish();
    else if (!heardSpeech && now - started > noSpeechMs) void finish();
    else if (now - started > maxMs) void finish();
  };
  source.connect(proc);
  proc.connect(ctx.destination);
  return { done, stop: () => void finish() };
}

async function resample(pcm: Float32Array, fromRate: number): Promise<Float32Array> {
  if (fromRate === TARGET_RATE) return pcm;
  const off = new OfflineAudioContext(1, Math.ceil((pcm.length * TARGET_RATE) / fromRate), TARGET_RATE);
  const buf = off.createBuffer(1, pcm.length, fromRate);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

// ── Whisper worker client ────────────────────────────────────────────────────

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
let readyPromise: Promise<void> | null = null;
let progressListener: ((loaded: number, total: number) => void) | null = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string; message?: string; loaded?: number; total?: number }>) => {
      const m = e.data;
      if (m.type === 'progress') progressListener?.(m.loaded ?? 0, m.total ?? 0);
      else if (m.type === 'result' && m.id !== undefined) {
        pending.get(m.id)?.resolve(m.text ?? '');
        pending.delete(m.id);
      } else if (m.type === 'error') {
        const p = m.id !== undefined ? pending.get(m.id) : undefined;
        if (p) {
          p.reject(new Error(m.message ?? 'Speech recognition failed.'));
          pending.delete(m.id!);
        } else for (const [, q] of pending) q.reject(new Error(m.message ?? 'Speech recognition failed.'));
      }
    };
    worker.onerror = (e) => {
      for (const [, q] of pending) q.reject(new Error(e.message || 'The speech model could not start.'));
      pending.clear();
      readyPromise = null;
    };
  }
  return worker;
}

/** Start downloading the model early (for example on the first tap), so it is ready when speech ends. */
export function warmUp(onProgress?: (loaded: number, total: number) => void): Promise<void> {
  progressListener = onProgress ?? progressListener;
  if (!readyPromise) {
    const w = getWorker();
    readyPromise = new Promise<void>((resolve, reject) => {
      const onMsg = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data.type === 'ready') {
          w.removeEventListener('message', onMsg);
          resolve();
        } else if (e.data.type === 'error') {
          w.removeEventListener('message', onMsg);
          readyPromise = null;
          reject(new Error(e.data.message ?? 'The speech model could not load.'));
        }
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'load' });
    });
  }
  return readyPromise;
}

export function transcribe(audio: Float32Array): Promise<string> {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}
