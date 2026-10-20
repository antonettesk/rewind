import { AlertTriangle, Check, Copy, Loader2, X } from './icons';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Tone } from '../lib/strings';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

// ── Buttons ──
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border border-transparent shadow-sm',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'text-fg-2 hover:text-fg hover:bg-surface-2 border border-transparent',
  danger: 'bg-bad text-white hover:opacity-90 border border-transparent',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        VARIANT[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// ── Badges ──
const TONE: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  neutral: 'bg-surface-2 text-fg-2',
  accent: 'bg-accent-soft text-accent',
};
const DOT: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-fg-3', accent: 'bg-accent' };

export function Badge({ tone = 'neutral', children, dot = true, pulse, title, className }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; title?: string; className?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone], className)}>
      {dot && <span aria-hidden className={cx('size-1.5 rounded-full', DOT[tone], pulse && 'pulse-dot')} />}
      {children}
    </span>
  );
}

export function LabeledBadge({ map, value, pulseWhen }: { map: Record<string, { label: string; tone: Tone; help?: string }>; value: string; pulseWhen?: string[] }) {
  const m = map[value] ?? { label: value, tone: 'neutral' as Tone };
  return (
    <Badge tone={m.tone} title={m.help} pulse={pulseWhen?.includes(value)}>
      {m.label}
    </Badge>
  );
}

/** Provenance label: what was recorded vs derived vs unavailable. */
export function Provenance({ kind }: { kind: 'recorded' | 'derived' | 'unavailable' }) {
  const text = { recorded: 'Recorded', derived: 'Derived', unavailable: 'Not captured' }[kind];
  const help = {
    recorded: 'Persisted verbatim when it happened.',
    derived: 'Computed from recorded facts by REWIND.',
    unavailable: 'This adapter did not capture this information.',
  }[kind];
  return (
    <span title={help} className={cx('rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide', kind === 'unavailable' ? 'border-border text-fg-3' : 'border-border-strong text-fg-2')}>
      {text}
    </span>
  );
}

// ── Layout primitives ──
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · REWIND`;
  }, [title]);
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-lg border border-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-fg-2">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton', className)} />;
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-fg-3">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-fg-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-bad/30 bg-bad-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
      <div className="flex-1">
        <p className="font-medium text-bad">Something went wrong</p>
        <p className="mt-0.5 text-fg-2">{message}</p>
        <p className="mt-1 text-xs text-fg-3">Check that the server is running (`npm run start`) and try again.</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ── Copy ──
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-2 hover:bg-surface-2 hover:text-fg', className)}
      aria-label={`${label}: ${value.length > 40 ? 'value' : value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.push({ tone: 'bad', title: 'Copy failed', body: 'The browser blocked clipboard access.' });
        }
      }}
    >
      {done ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span className="sr-only sm:not-sr-only">{done ? 'Copied' : label}</span>
    </button>
  );
}

export function IdChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 py-0.5 pl-2 pr-0.5 font-mono text-xs text-fg-2">
      {id}
      <CopyButton value={id} label="Copy ID" className="!px-1" />
    </span>
  );
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cx('group relative min-w-0 rounded-md border border-border bg-code', className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-fg-3">{label}</span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-fg">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <pre className={cx('max-h-80 overflow-auto rounded-md border border-border bg-code p-3 font-mono text-xs leading-relaxed', className)}>
      <code>{text ?? 'null'}</code>
    </pre>
  );
}

// ── Dialog ──
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(92vw,30rem)] rounded-lg border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40"
    >
      {open && (
        <div>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close dialog">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="px-5 py-4 text-sm text-fg-2">{children}</div>
          <div className="flex justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">{footer}</div>
        </div>
      )}
    </dialog>
  );
}

// ── Toasts ──
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}
const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,22rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto rounded-lg border border-border bg-surface p-3 shadow-lg">
            <div className="flex items-start gap-2">
              <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', DOT[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                {t.body && <p className="mt-0.5 text-xs text-fg-2">{t.body}</p>}
              </div>
              <button type="button" className="text-fg-3 hover:text-fg" aria-label="Dismiss" onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Data hook ──
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload };
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs font-medium text-fg-2">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular tracking-tight', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-fg-3">{hint}</p>}
    </div>
  );
}
