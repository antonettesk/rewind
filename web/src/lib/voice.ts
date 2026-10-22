/**
 * Voice in and voice out for the agent demo.
 *
 * Speech in uses one of two engines:
 *  - "browser": the Web Speech API (instant, streams words as you speak).
 *    Used in Chrome and Safari, where it is reliable.
 *  - "device": OpenAI's open-source Whisper model running in the visitor's
 *    browser (Transformers.js). Used in Edge, Firefox, Brave and anywhere the
 *    Web Speech API is missing or stalls. Audio never leaves the device.
 * A watchdog switches from "browser" to "device" if the browser engine goes
 * quiet, so the ring can never hang on "Listening…".
 *
 * Speech out uses Amazon Polly when configured, otherwise the browser's voices.
 */
import { record, transcribe, warmUp } from './recorder';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type Engine = 'browser' | 'device';

/** Browsers whose built-in recognition is known to stall or be absent go straight to the on-device model. */
export function preferredEngine(): Engine {
  if (typeof navigator === 'undefined' || !recognitionCtor()) return 'device';
  const ua = navigator.userAgent;
  const brave = (navigator as unknown as { brave?: unknown }).brave !== undefined;
  if (/Edg\//.test(ua) || /OPR\//.test(ua) || /Firefox\//.test(ua) || brave) return 'device';
  return 'browser';
}

export const canListen = () => typeof navigator !== 'undefined' && (Boolean(navigator.mediaDevices?.getUserMedia) || recognitionCtor() !== null);
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

const ERRORS = {
  notAllowed: 'Microphone access was blocked. Allow it in the address bar, or type your request.',
  noSpeech: "I didn't hear anything. Try again, a little closer to the mic.",
  noMic: 'No microphone was found.',
  network: 'Speech recognition needs a network connection.',
} as const;

const BROWSER_ERRORS: Record<string, string> = {
  'not-allowed': ERRORS.notAllowed,
  'no-speech': ERRORS.noSpeech,
  'audio-capture': ERRORS.noMic,
};

export interface ListenHandlers {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
  /** 0–1 microphone level while listening (on-device engine). */
  onLevel?: (level: number) => void;
  /** "listening" while capturing, "transcribing" while the model works. */
  onPhase?: (phase: 'listening' | 'transcribing') => void;
  /** Short status for the UI, such as model download progress; null clears it. */
  onStatus?: (text: string | null) => void;
}

/** Push-to-talk. Call the returned stop() to end early. */
export function listen(h: ListenHandlers): () => void {
  return preferredEngine() === 'browser' ? listenBrowser(h) : listenDevice(h);
}

function listenDevice(h: ListenHandlers): () => void {
  let stopFn: (() => void) | null = null;
  let cancelled = false;
  h.onPhase?.('listening');
  // Download the model while the visitor talks, so it is usually ready by the time they stop.
  const ready = warmUp((loaded, total) => {
    if (total > 0 && loaded < total) h.onStatus?.(`Loading the on-device speech model… ${Math.round((loaded / total) * 100)}%`);
  });
  ready.catch(() => undefined);
  void (async () => {
    try {
      const rec = await record({ onLevel: h.onLevel });
      stopFn = rec.stop;
      if (cancelled) rec.stop();
      const audio = await rec.done;
      if (!audio) {
        h.onError(ERRORS.noSpeech);
        return;
      }
      h.onPhase?.('transcribing');
      await ready;
      h.onStatus?.('Transcribing on your device…');
      // Whisper marks non-speech like "[BLANK_AUDIO]" or "(wind)"; drop those.
      const text = (await transcribe(audio)).replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
      h.onStatus?.(null);
      if (text) {
        h.onInterim?.(text);
        h.onFinal(text);
      } else h.onError(ERRORS.noSpeech);
    } catch (e) {
      h.onStatus?.(null);
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') h.onError(ERRORS.notAllowed);
      else if (name === 'NotFoundError') h.onError(ERRORS.noMic);
      else h.onError(`Voice input failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      h.onLevel?.(0);
      h.onEnd();
    }
  })();
  return () => {
    cancelled = true;
    stopFn?.();
  };
}

function listenBrowser(h: ListenHandlers): () => void {
  const Ctor = recognitionCtor()!;
  const r = new Ctor();
  r.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let finalText = '';
  let interimText = '';
  let ended = false;
  let fellBack = false;
  let deviceStop: (() => void) | null = null;
  let noResult: ReturnType<typeof setTimeout> | undefined;
  h.onPhase?.('listening');

  // If the browser engine goes quiet, abandon it and use the on-device model instead.
  const fallBack = (why: string) => {
    if (ended || fellBack) return;
    fellBack = true;
    clearTimeout(noAudio);
    clearTimeout(noResult);
    r.onend = null;
    r.onerror = null;
    try {
      r.abort();
    } catch {
      /* already stopped */
    }
    h.onStatus?.(`${why} Switched to on-device recognition: please say it again.`);
    deviceStop = listenDevice(h);
  };
  const noAudio = setTimeout(() => fallBack('The browser speech service did not start.'), 4_000);

  r.onaudiostart = () => clearTimeout(noAudio);
  r.onspeechend = () => {
    noResult = setTimeout(() => {
      if (!finalText && !interimText) fallBack('The browser speech service did not answer.');
    }, 10_000);
  };
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]!;
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    interimText = interim;
    h.onInterim?.((finalText + interim).trim());
  };
  r.onerror = (e) => {
    if (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') {
      fallBack(e.error === 'network' ? ERRORS.network : 'The browser speech service is unavailable here.');
      return;
    }
    if (e.error !== 'aborted') h.onError(BROWSER_ERRORS[e.error] ?? `Speech recognition stopped (${e.error}).`);
  };
  r.onend = () => {
    if (fellBack) return;
    ended = true;
    clearTimeout(noAudio);
    clearTimeout(noResult);
    const text = (finalText || interimText).trim();
    if (text) h.onFinal(text);
    h.onEnd();
  };
  try {
    r.start();
  } catch {
    fallBack('The browser speech service could not start.');
  }
  return () => {
    if (deviceStop) return deviceStop();
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
  };
}

let currentAudio: HTMLAudioElement | null = null;

/** Stop anything that is speaking. */
export function hush() {
  if (canSpeak()) window.speechSynthesis.cancel();
  currentAudio?.pause();
  currentAudio = null;
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  const prefer = [/natural/i, /neural/i, /samantha/i, /aria|jenny|ava/i, /google us english/i];
  for (const re of prefer) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === 'en-US') ?? voices[0];
}

/**
 * Say something. Uses an MP3 URL (Amazon Polly) when given, otherwise the
 * browser's own voices. Resolves when speech ends; never rejects.
 */
export function say(text: string, opts: { audioUrl?: string } = {}): Promise<void> {
  hush();
  return new Promise((resolve) => {
    if (opts.audioUrl) {
      const a = new Audio(opts.audioUrl);
      currentAudio = a;
      a.onended = () => resolve();
      a.onerror = () => void sayWithBrowser(text).then(resolve);
      a.play().catch(() => void sayWithBrowser(text).then(resolve));
      return;
    }
    void sayWithBrowser(text).then(resolve);
  });
}

function sayWithBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak() || !text.trim()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.02;
    u.pitch = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    // Some browsers never fire onend for long utterances; never leave the caller waiting.
    setTimeout(resolve, Math.min(30_000, 2_000 + text.length * 90));
    window.speechSynthesis.speak(u);
  });
}

/** What the assistant says before acting, built from the validated plan. */
export function confirmation(steps: { operation: string; input: Record<string, unknown> }[]): string {
  if (!steps.length) return "Sorry, I can't do that with this home yet. Try the thermostat, the task list, a message, or the security routine.";
  const parts = steps.map((s) => {
    const i = s.input as Record<string, any>;
    switch (s.operation) {
      case 'thermostat.set_mode':
        return `set the thermostat to ${i.mode}${i.targetC ? ` at ${i.targetC} degrees` : ''}`;
      case 'tasks.update':
        return `add "${(i.add ?? [])[0] ?? 'a task'}" to your list`;
      case 'notify.send_message':
        return 'message the household';
      case 'security.activate_routine':
        return 'arm the weekend security routine';
      case 'security.disarm':
        return 'disarm security';
      default:
        return s.operation;
    }
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts[0];
  return `Okay. I'll ${list}. REWIND is watching every step.`;
}
