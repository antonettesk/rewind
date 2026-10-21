import { useRef, useState } from 'react';
import { ArrowRight } from '../../components/icons';
import { cx } from '../../components/ui';
import { VoiceOrb, type VoiceState } from '../../components/VoiceOrb';
import { planFromRequest, SAMPLE_PROMPTS } from '../../lib/planner';
import { canListen, listen } from '../../lib/voice';

/**
 * "Ask your home": type or say a request. The deterministic planner previews
 * which registered operations it maps to, then the live demo runs it for real
 * over MCP with a failure injected on the last step.
 */
export function AskBox({ onRun, busy }: { onRun: (request: string, opts: { voice: boolean }) => void; busy: boolean }) {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const plan = text.trim().length > 2 ? planFromRequest(text) : [];

  const submit = (t = text, spoken = false) => {
    const clean = t.trim().slice(0, 500);
    if (!clean) return setHint('Type a request, or tap the ring and say one.');
    if (!planFromRequest(clean).length) return setHint('This home has a thermostat, a task list, a household message and a security routine. Ask it to do something with those.');
    setHint(null);
    onRun(clean, { voice: spoken });
  };

  const mic = () => {
    if (voice === 'listening') return stop.current?.();
    setHint(null);
    setVoice('listening');
    let heard = '';
    stop.current = listen({
      onInterim: setText,
      onFinal: (t) => {
        heard = t;
        setText(t);
      },
      onError: (m) => {
        setHint(m);
        setVoice('error');
        setTimeout(() => setVoice('idle'), 1500);
      },
      onEnd: () => {
        stop.current = null;
        setVoice((v) => (v === 'listening' ? 'idle' : v));
        if (heard) submit(heard, true);
      },
    });
  };

  return (
    <div className="mx-auto mt-10 max-w-2xl text-left">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="beam flex items-center gap-3 rounded-full border border-white/10 bg-white/[.04] p-2 pl-2 shadow-[0_20px_60px_-20px_rgba(99,102,241,.6)] backdrop-blur-xl transition-colors focus-within:border-white/30 focus-within:bg-white/[.07]"
      >
        {canListen() ? <VoiceOrb state={voice} onClick={mic} disabled={busy} /> : <span className="w-2" />}
        <label className="min-w-0 flex-1">
          <span className="sr-only">Ask your home to do something</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            disabled={busy || voice === 'listening'}
            placeholder={voice === 'listening' ? 'Listening…' : 'Ask your home… “set the heat to 18 and lock up”'}
            className="w-full bg-transparent py-3 text-[15px] text-white outline-none placeholder:text-white/35 focus-visible:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black transition hover:shadow-[0_0_32px_-4px_rgba(103,232,249,.9)] disabled:opacity-60"
        >
          {busy ? <span className="size-4 animate-spin rounded-full border-2 border-black/30 border-t-black" aria-hidden /> : null}
          Run it
          <ArrowRight className="size-4" aria-hidden />
        </button>
      </form>

      <div className="mt-3 min-h-6 px-3 text-xs">
        {hint ? (
          <p className="text-amber-300" role="status">
            {hint}
          </p>
        ) : plan.length ? (
          <p className="flex flex-wrap items-center gap-1.5 text-white/50" aria-live="polite">
            <span>REWIND will run:</span>
            {plan.map((s, i) => (
              <span key={s.operation} className={cx('rounded-full border px-2 py-0.5 font-mono text-[10px]', i === plan.length - 1 ? 'border-rose-400/40 text-rose-200' : 'border-white/15 text-white/70')}>
                {s.operation}
                {i === plan.length - 1 && plan.length > 1 ? ' · will fail' : ''}
              </span>
            ))}
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-white/40">
            <span>Try:</span>
            {SAMPLE_PROMPTS.map((p) => (
              <button key={p.label} type="button" onClick={() => setText(p.text)} className="rounded-full border border-white/10 px-2.5 py-0.5 text-white/60 transition hover:border-white/30 hover:text-white">
                {p.label}
              </button>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}
