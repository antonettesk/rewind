/**
 * Voice in and voice out for the agent demo, using what the browser already
 * has: the Web Speech API for recognition and speechSynthesis for replies.
 * Free and keyless. Recognition is performed by the browser vendor's service
 * (Chrome: Google, Edge: Microsoft, Safari: Apple); REWIND never receives audio,
 * only the final transcript the visitor chooses to send.
 */

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
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canListen = () => recognitionCtor() !== null;
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the address bar, or type your request.',
  'service-not-allowed': 'This browser does not allow speech recognition here. Type your request instead.',
  'no-speech': "I didn't hear anything. Try again, a little closer to the mic.",
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection.',
};

/** Push-to-talk: resolves with the final transcript. Call the returned stop() to end early. */
export function listen(handlers: { onInterim?: (text: string) => void; onFinal: (text: string) => void; onError: (message: string) => void; onEnd: () => void }) {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    handlers.onError('Speech recognition is not available in this browser. Chrome, Edge and Safari support it.');
    handlers.onEnd();
    return () => undefined;
  }
  const r = new Ctor();
  r.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]!;
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    handlers.onInterim?.((finalText + interim).trim());
  };
  r.onerror = (e) => {
    if (e.error !== 'aborted') handlers.onError(ERRORS[e.error] ?? `Speech recognition stopped (${e.error}).`);
  };
  r.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  r.start();
  return () => r.stop();
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
