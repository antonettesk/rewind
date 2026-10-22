import { cx } from './ui';
import { Mic } from './icons';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

const LABEL: Record<VoiceState, string> = {
  idle: 'Tap to speak',
  listening: 'Listening…',
  thinking: 'Working…',
  speaking: 'Speaking…',
  error: 'Try again',
};

/**
 * An Echo-style light ring. Cyan sweeps while listening, the ring spins while
 * Rewind works, and it pulses while the assistant speaks.
 */
export function VoiceOrb({ state, onClick, disabled, size = 'md', level = 0 }: { state: VoiceState; onClick: () => void; disabled?: boolean; size?: 'md' | 'lg'; level?: number }) {
  const dim = size === 'lg' ? 'size-20' : 'size-14';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={state === 'listening' ? 'Stop listening' : 'Speak your request'}
      aria-pressed={state === 'listening'}
      title={LABEL[state]}
      className={cx('group relative shrink-0 rounded-full outline-offset-4 transition-transform active:scale-95 disabled:opacity-40', dim)}
    >
      {/* Light ring; only the ring fades, never the device face. */}
      <span
        aria-hidden
        className={cx(
          'absolute inset-0 rounded-full transition-opacity duration-500',
          state === 'idle' ? 'opacity-70 group-hover:opacity-100' : 'opacity-100',
          state === 'error' ? 'bg-rose-500' : 'orb',
          state === 'thinking' && '[animation-duration:1.4s]',
          state === 'listening' && '[animation-duration:3s]',
          state === 'speaking' && level === 0 && 'animate-pulse',
        )}
      />
      <span aria-hidden className="absolute inset-[3px] rounded-full bg-[radial-gradient(circle_at_50%_35%,#23252e,#0b0c10_70%)] shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" />
      {/* Glow */}
      <span
        aria-hidden
        style={state === 'listening' || (state === 'speaking' && level > 0) ? { transform: `scale(${1 + level * 0.35})`, opacity: 0.35 + level * 0.65 } : undefined}
        className={cx(
          'orb absolute -inset-2 -z-10 rounded-full blur-xl transition-[opacity,transform] duration-100',
          state === 'speaking' ? 'opacity-70' : state === 'thinking' ? 'opacity-40' : state === 'listening' ? '' : 'opacity-0',
        )}
      />
      <span className="relative flex size-full items-center justify-center text-white">
        {state === 'thinking' ? (
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-bounce rounded-full bg-cyan-200" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </span>
        ) : (
          <Mic className={size === 'lg' ? 'size-7' : 'size-5'} aria-hidden />
        )}
      </span>
      <span className="sr-only" aria-live="polite">
        {LABEL[state]}
      </span>
    </button>
  );
}
