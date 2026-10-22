/**
 * The assistant's voice.
 *
 * 1. Amazon Polly (neural), when the server has AWS configured: the same
 *    family of speech technology as Alexa. Audio is fetched as bytes and played
 *    through Web Audio, so the light ring can follow its real loudness and no
 *    media policy has to be relaxed.
 * 2. Otherwise the best natural voice the browser has (Edge: Ava, Andrew,
 *    Jenny "Natural"; Chrome: Google US English; Safari: Samantha), spoken a
 *    sentence at a time, which avoids Chrome's cut-off bug. Every path has a
 *    time limit, so speaking can never leave the caller waiting.
 *
 * Also: short, original earcons for "listening" and "done", synthesized here.
 */

/** Opt-in diagnostics: localStorage['rewind:debug-voice'] = '1'. */
const debug = (...args: unknown[]) => {
  try {
    if (localStorage.getItem('rewind:debug-voice')) console.debug('[voice]', Math.round(performance.now()), ...args);
  } catch {
    /* storage unavailable */
  }
};

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export const canSpeak = () => typeof window !== 'undefined' && ('speechSynthesis' in window || 'AudioContext' in window);

// ── Earcons ──────────────────────────────────────────────────────────────────

/** Rising two-note chime when the assistant starts listening; falling when it stops; low buzz for an error. */
export function chime(kind: 'listen' | 'done' | 'error') {
  const a = audio();
  if (!a) return;
  const notes = kind === 'listen' ? [659.25, 987.77] : kind === 'done' ? [987.77, 659.25] : [220, 196];
  const now = a.currentTime;
  notes.forEach((f, i) => {
    const t = now + i * 0.09;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = kind === 'error' ? 'triangle' : 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(kind === 'error' ? 0.09 : 0.12, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.34);
  });
}

// ── Speaking ─────────────────────────────────────────────────────────────────

let stopCurrent: (() => void) | null = null;

/** Stop anything that is speaking. */
export function hush() {
  stopCurrent?.();
  stopCurrent = null;
  cancelIfBusy();
}

/** Chromium's engine can stall the next utterance after a needless cancel(), so only cancel real speech. */
let lastCancel = 0;
function cancelIfBusy() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (synth.speaking || synth.pending) {
    synth.cancel();
    lastCancel = performance.now();
  }
}

export interface SayOptions {
  /** Fetches Polly audio bytes; omitted when Polly is not configured. */
  fetchAudio?: () => Promise<ArrayBuffer>;
  /** 0–1 loudness while speaking, for the light ring. */
  onLevel?: (level: number) => void;
}

/** Say something. Resolves when speech ends; never rejects. */
export async function say(text: string, opts: SayOptions = {}): Promise<void> {
  debug('say', JSON.stringify(text.slice(0, 40)), opts.fetchAudio ? 'polly' : 'browser');
  hush();
  if (!text.trim()) return;
  if (opts.fetchAudio) {
    try {
      const bytes = await withTimeout(opts.fetchAudio(), 12_000);
      await playBytes(bytes, opts.onLevel);
      return;
    } catch {
      /* fall back to the browser voice */
    }
  }
  await sayWithBrowser(text, opts.onLevel);
  opts.onLevel?.(0);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function playBytes(bytes: ArrayBuffer, onLevel?: (n: number) => void): Promise<void> {
  const a = audio();
  if (!a) throw new Error('no audio');
  const buffer = await a.decodeAudioData(bytes.slice(0));
  await new Promise<void>((resolve) => {
    const src = a.createBufferSource();
    src.buffer = buffer;
    const analyser = a.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser).connect(a.destination);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4));
      raf = requestAnimationFrame(tick);
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      onLevel?.(0);
      resolve();
    };
    src.onended = finish;
    stopCurrent = () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      finish();
    };
    src.start();
    if (onLevel) raf = requestAnimationFrame(tick);
    setTimeout(finish, (buffer.duration + 2) * 1000);
  });
}

// Browser voices ──────────────────────────────────────────────────────────────

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;
function voices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  voicesPromise ??= new Promise((resolve) => {
    const now = window.speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1_500);
  });
  return voicesPromise;
}

/** The most natural English voice available, preferring US English. */
export async function bestVoice(): Promise<SpeechSynthesisVoice | undefined> {
  const all = (await voices()).filter((v) => /^en(-|_|$)/i.test(v.lang));
  const us = all.filter((v) => /en[-_]US/i.test(v.lang));
  // US English first, a warm female voice where possible (the Alexa convention), natural/neural above all.
  const prefer = [
    /\b(Ava|Jenny|Aria|Emma|Michelle)\b.*(Natural|Online)/i,
    /(Natural|Neural|Online)/i,
    /Google US English/i,
    /\b(Samantha|Allison|Ava|Susan|Zira)\b/i,
  ];
  for (const re of prefer) {
    const v = us.find((x) => re.test(x.name));
    if (v) return v;
  }
  return us[0] ?? all.find((v) => /(Natural|Neural|Online)/i.test(v.name)) ?? all[0];
}

function sentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && last.length + p.length < 180) out[out.length - 1] = last + p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Chromium can garbage-collect an utterance that is still speaking; its end
 * event is then lost and speech appears to stall. Holding a reference until
 * each utterance finishes prevents that.
 */
const speaking = new Set<SpeechSynthesisUtterance>();

async function sayWithBrowser(text: string, onLevel?: (n: number) => void): Promise<void> {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const voice = await bestVoice();
  // No voices installed (some Linux builds, headless browsers): stay silent instead of waiting.
  if (!voice) return;
  let stopped = false;
  stopCurrent = () => {
    stopped = true;
    cancelIfBusy();
  };
  // Local voices (Windows SAPI, macOS) take a whole reply in one go. Network voices
  // (Chrome's Google voices) cut off after ~15 s, so those are spoken a sentence at a time.
  const chunks = voice.localService ? [text.trim()] : sentences(text);
  for (const chunk of chunks) {
    debug('chunk', stopped ? 'SKIPPED (stopped)' : '', JSON.stringify(chunk.slice(0, 40)));
    if (stopped) return;
    // Windows speech in Chromium can wedge when an utterance follows a finished one;
    // a reset and a short pause before each one avoids that.
    synth.cancel();
    lastCancel = performance.now();
    await new Promise((r) => setTimeout(r, 300));
    let outcome = await speakOnce(synth, chunk, voice, onLevel);
    if (outcome === 'never started' && !stopped) {
      debug('retry', JSON.stringify(chunk.slice(0, 30)));
      synth.cancel();
      await new Promise((r) => setTimeout(r, 500));
      outcome = await speakOnce(synth, chunk, voice, onLevel);
    }
    if (outcome === 'never started') return;
  }
}

type Outcome = 'end' | 'error' | 'time limit' | 'never started';

function speakOnce(synth: SpeechSynthesis, chunk: string, voice: SpeechSynthesisVoice, onLevel?: (n: number) => void): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1.02;
    u.pitch = 1;
    let decay: ReturnType<typeof setInterval> | undefined;
    let level = 0;
    let settled = false;
    const finish = (why: Outcome, detail = '') => {
      if (settled) return;
      settled = true;
      debug('finish', why, detail, JSON.stringify(chunk.slice(0, 30)));
      speaking.delete(u);
      clearTimeout(limit);
      clearTimeout(noStart);
      clearInterval(decay);
      onLevel?.(0);
      resolve(why);
    };
    // Word boundaries pulse the ring, then the glow decays between words.
    u.onboundary = () => {
      level = 0.85;
      onLevel?.(level);
    };
    u.onstart = () => {
      clearTimeout(noStart);
      decay = setInterval(() => {
        level = Math.max(0.25, level * 0.8);
        onLevel?.(level);
      }, 80);
    };
    u.onend = () => finish('end');
    u.onerror = (e) => finish('error', e.error);
    const limit = setTimeout(() => {
      cancelIfBusy();
      finish('time limit');
    }, 4_000 + chunk.length * 110);
    const noStart = setTimeout(() => {
      cancelIfBusy();
      finish('never started');
    }, 3_000);
    speaking.add(u);
    synth.speak(u);
    // Chromium sometimes queues speech in a paused state; resume() is harmless otherwise.
    synth.resume();
  });
}
