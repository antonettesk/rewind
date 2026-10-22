/**
 * Rewind Theater: an animated replay of an execution's *recorded* audit events.
 *
 * Every state shown here comes from a persisted event: steps light up when
 * `action.started`/`succeeded` were recorded, the failure pulses on
 * `action.failed`, and the rewind sweeps back across `compensation.started` →
 * `verification.passed`. Events are revealed one at a time so a person can
 * follow what happened in milliseconds; nothing is invented or reordered.
 */
import { AlertTriangle, Check, CircleSlash, Launch, ListChecks, Lock, MessageSquare, Pause, Play, RotateCcw, Shield, Thermometer, X } from './icons';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEvent, ExecutionView } from '../lib/api';
import { EVENT_LABEL } from '../lib/strings';
import { cx } from './ui';

type NodeState = 'idle' | 'approval' | 'running' | 'done' | 'failed' | 'denied' | 'unknown' | 'rewinding' | 'restored' | 'restore_failed' | 'conflict' | 'unrecoverable';

const ICONS: Record<string, typeof Thermometer> = {
  thermostat: Thermometer,
  tasks: ListChecks,
  security: Shield,
  notifications: MessageSquare,
};

const STATE_STYLE: Record<NodeState, { ring: string; chip: string; label: string }> = {
  idle: { ring: 'border-border', chip: 'bg-surface-2 text-fg-3', label: 'Planned' },
  approval: { ring: 'border-warn/60', chip: 'bg-warn-soft text-warn', label: 'Needs approval' },
  running: { ring: 'border-info', chip: 'bg-info-soft text-info', label: 'Running' },
  done: { ring: 'border-ok/50', chip: 'bg-ok-soft text-ok', label: 'Applied' },
  failed: { ring: 'border-bad', chip: 'bg-bad-soft text-bad', label: 'Failed · no effect' },
  denied: { ring: 'border-bad', chip: 'bg-bad-soft text-bad', label: 'Denied by policy' },
  unknown: { ring: 'border-warn', chip: 'bg-warn-soft text-warn', label: 'Outcome unknown' },
  rewinding: { ring: 'border-brand-b', chip: 'bg-accent-soft text-accent', label: 'Rewinding…' },
  restored: { ring: 'border-ok', chip: 'bg-ok-soft text-ok', label: 'Restored · verified' },
  restore_failed: { ring: 'border-bad', chip: 'bg-bad-soft text-bad', label: 'Restore not verified' },
  conflict: { ring: 'border-warn', chip: 'bg-warn-soft text-warn', label: 'Changed by someone else' },
  unrecoverable: { ring: 'border-bad/60', chip: 'bg-bad-soft text-bad', label: 'Cannot be undone' },
};

const VISIBLE = new Set([
  'action.started',
  'action.succeeded',
  'action.failed',
  'action.outcome_unknown',
  'action.retry_scheduled',
  'approval.requested',
  'approval.granted',
  'execution.halted',
  'recovery.planned',
  'reconciliation.completed',
  'compensation.started',
  'compensation.failed',
  'compensation.conflict',
  'compensation.blocked',
  'verification.passed',
  'verification.failed',
  'recovery.completed',
  'recovery.not_required',
]);

export function RewindTheater({ view, stepMs = 520, autoReplay = true, compact = false }: { view: ExecutionView | null; stepMs?: number; autoReplay?: boolean; compact?: boolean }) {
  const events = useMemo(() => (view?.events ?? []).filter((e) => VISIBLE.has(e.eventType) || (e.eventType === 'policy.evaluated' && e.payload.decision === 'deny')), [view]);
  const [shown, setShown] = useState(autoReplay ? 0 : events.length);
  const [paused, setPaused] = useState(false);
  const executionId = view?.execution.id;
  const lastId = useRef<string | undefined>(undefined);

  // New execution: start the replay from the beginning.
  useEffect(() => {
    if (executionId !== lastId.current) {
      lastId.current = executionId;
      setShown(autoReplay ? 0 : events.length);
      setPaused(false);
    }
  }, [executionId, autoReplay, events.length]);

  // Reveal recorded events one by one; new live events join the queue.
  useEffect(() => {
    if (paused || shown >= events.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 200 : stepMs);
    return () => clearTimeout(t);
  }, [shown, events.length, paused, stepMs]);

  const seqOf = useMemo(() => new Map(view?.actions.map((a) => [a.id, a.sequence]) ?? []), [view]);
  const played = events.slice(0, shown);
  const current = played.at(-1);
  const done = shown >= events.length && view !== null && !['running', 'pending', 'recovering'].includes(view.execution.status);

  const states = new Map<number, NodeState>();
  let rewindStarted = false;
  for (const e of played) {
    const p = e.payload as Record<string, any>;
    const seq: number | undefined = typeof p.sequence === 'number' ? p.sequence : typeof p.actionId === 'string' ? seqOf.get(p.actionId) : undefined;
    if (seq === undefined) {
      if (e.eventType === 'recovery.planned') rewindStarted = (p.order?.length ?? 0) > 0;
      continue;
    }
    switch (e.eventType) {
      case 'approval.requested': states.set(seq, 'approval'); break;
      case 'action.started': states.set(seq, 'running'); break;
      case 'action.succeeded': states.set(seq, 'done'); break;
      case 'action.failed': states.set(seq, 'failed'); break;
      case 'policy.evaluated': states.set(seq, 'denied'); break;
      case 'action.outcome_unknown': states.set(seq, 'unknown'); break;
      case 'compensation.started': states.set(seq, 'rewinding'); rewindStarted = true; break;
      case 'verification.passed': states.set(seq, 'restored'); break;
      case 'verification.failed':
      case 'compensation.failed': states.set(seq, 'restore_failed'); break;
      case 'compensation.conflict': states.set(seq, 'conflict'); break;
    }
  }
  // At the end, mark effects that remain and could never be undone.
  if (done && view) {
    for (const a of view.actions) if (a.recoveryOutcome === 'recovery_unavailable') states.set(a.sequence, 'unrecoverable');
  }

  const actions = view?.actions ?? [];
  const forwardHead = Math.max(0, ...actions.filter((a) => ['running', 'done', 'failed', 'unknown', 'denied', 'rewinding', 'restored', 'restore_failed', 'conflict', 'unrecoverable', 'approval'].includes(states.get(a.sequence) ?? 'idle')).map((a) => a.sequence));
  const rewindTargets = actions.filter((a) => ['rewinding', 'restored', 'restore_failed', 'conflict'].includes(states.get(a.sequence) ?? '')).map((a) => a.sequence);
  const rewindTail = rewindTargets.length ? Math.min(...rewindTargets) : null;
  const n = Math.max(actions.length, 1);
  const pct = (seq: number) => ((seq - 0.5) / n) * 100;

  if (!view) {
    return (
      <div className={cx('relative overflow-hidden rounded-xl border border-border bg-surface', compact ? 'p-4' : 'p-6')}>
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative flex flex-col items-center justify-center gap-2 py-10 text-center">
          <RotateCcw className="size-6 text-fg-3" aria-hidden />
          <p className="text-sm font-medium">The rewind theater is ready</p>
          <p className="max-w-sm text-xs text-fg-2">Run the agent and every recorded step, failure, compensation and verification plays back here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cx('relative overflow-hidden rounded-xl border border-border bg-surface', compact ? 'p-4' : 'p-5 sm:p-6')} aria-label="Execution replay">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-50" aria-hidden />
      <div className="relative">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold', rewindStarted ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-2')}>
              {rewindStarted ? <RotateCcw className="size-3" aria-hidden /> : <Launch className="size-3" aria-hidden />}
              {rewindStarted ? 'Rewind' : 'Forward'}
            </span>
            <span className="text-fg-3">
              Replaying {shown}/{events.length} recorded events
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              disabled={shown >= events.length}
              className="rounded-md p-1.5 text-fg-2 hover:bg-surface-2 hover:text-fg disabled:opacity-40"
              aria-label={paused ? 'Resume replay' : 'Pause replay'}
            >
              {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => {
                setShown(0);
                setPaused(false);
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-2 hover:bg-surface-2 hover:text-fg"
            >
              <RotateCcw className="size-3.5" aria-hidden /> Replay
            </button>
          </div>
        </div>

        {/* Track */}
        <div className="overflow-x-auto pb-1 pt-3">
          <div className="relative mx-auto" style={{ minWidth: `${Math.max(actions.length, 1) * 168}px` }}>
            <div className="absolute left-0 right-0 top-[38px] h-[3px] rounded-full bg-border" aria-hidden />
            <motion.div
              className="absolute left-0 top-[38px] h-[3px] rounded-full bg-ok/70"
              initial={false}
              animate={{ width: forwardHead ? `${pct(forwardHead)}%` : '0%' }}
              transition={{ type: 'spring', stiffness: 120, damping: 22 }}
              aria-hidden
            />
            <AnimatePresence>
              {rewindTail !== null && (
                <motion.div
                  key="rewind"
                  className="bg-brand absolute top-[37px] h-[5px] rounded-full shadow-[0_0_16px_var(--brand-b)]"
                  initial={{ left: `${pct(forwardHead)}%`, right: `${100 - pct(forwardHead)}%`, opacity: 0 }}
                  animate={{ left: `${pct(rewindTail)}%`, right: `${100 - pct(forwardHead)}%`, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 90, damping: 20 }}
                  aria-hidden
                />
              )}
            </AnimatePresence>

            <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${Math.max(actions.length, 1)}, minmax(0, 1fr))` }}>
              {actions.map((a) => {
                const st = states.get(a.sequence) ?? 'idle';
                const style = STATE_STYLE[st];
                const Icon = ICONS[a.resourceType] ?? Lock;
                const active = current && ((current.payload as any).sequence === a.sequence || seqOf.get((current.payload as any).actionId) === a.sequence);
                return (
                  <li key={a.id} className="flex flex-col items-center px-2 text-center">
                    <motion.div
                      initial={false}
                      animate={st === 'failed' || st === 'denied' ? { x: [0, -5, 5, -3, 3, 0] } : st === 'rewinding' ? { rotate: [0, -12, 0] } : { x: 0, rotate: 0 }}
                      transition={{ duration: 0.5 }}
                      className={cx(
                        'relative z-10 flex size-[78px] items-center justify-center rounded-2xl border-2 bg-surface transition-colors duration-500',
                        style.ring,
                        active && 'shadow-[0_0_0_6px_color-mix(in_oklab,var(--accent)_18%,transparent)]',
                      )}
                    >
                      <Icon className={cx('size-7 transition-colors duration-500', st === 'idle' ? 'text-fg-3' : 'text-fg')} aria-hidden />
                      <StatusDot state={st} />
                    </motion.div>
                    <p className="mt-3 text-sm font-medium leading-tight">{a.operationTitle}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-fg-3">step {a.sequence}</p>
                    <motion.span
                      key={st}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cx('mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium', style.chip)}
                    >
                      {style.label}
                    </motion.span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* Ticker */}
        <div className="mt-5 flex min-h-[44px] items-center justify-between gap-3 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
          <p key={current?.seq ?? 'none'} className="animate-[ticker-in_180ms_ease-out] min-w-0 truncate text-sm" aria-live="polite">
            {current ? <Ticker e={current} title={(seq: number) => actions.find((a) => a.sequence === seq)?.operationTitle} seqOf={seqOf} /> : <span className="text-fg-3">Waiting for the first recorded event…</span>}
          </p>
          {done && <Verdict status={view.execution.status} />}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ state }: { state: NodeState }) {
  const map: Partial<Record<NodeState, { icon: typeof Check; cls: string }>> = {
    done: { icon: Check, cls: 'bg-ok text-white' },
    restored: { icon: Check, cls: 'bg-ok text-white' },
    failed: { icon: X, cls: 'bg-bad text-white' },
    denied: { icon: CircleSlash, cls: 'bg-bad text-white' },
    restore_failed: { icon: X, cls: 'bg-bad text-white' },
    unrecoverable: { icon: AlertTriangle, cls: 'bg-bad text-white' },
    unknown: { icon: AlertTriangle, cls: 'bg-warn text-white' },
    conflict: { icon: AlertTriangle, cls: 'bg-warn text-white' },
    rewinding: { icon: RotateCcw, cls: 'bg-brand text-white' },
  };
  const m = map[state];
  return (
    <AnimatePresence>
      {m && (
        <motion.span
          key={state}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 18 }}
          className={cx('absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border-2 border-surface', m.cls)}
        >
          <m.icon className={cx('size-3.5', state === 'rewinding' && 'animate-spin [animation-duration:1.4s] [animation-direction:reverse]')} aria-hidden />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function Ticker({ e, title, seqOf }: { e: AuditEvent; title: (seq: number) => string | undefined; seqOf: Map<string, number> }) {
  const p = e.payload as Record<string, any>;
  const seq: number | undefined = typeof p.sequence === 'number' ? p.sequence : seqOf.get(p.actionId);
  const what = seq !== undefined ? title(seq) : undefined;
  let detail = '';
  if (e.eventType === 'action.failed' || e.eventType === 'action.outcome_unknown') detail = p.error?.code;
  if (e.eventType === 'recovery.planned') detail = p.order?.length ? `undo order ${p.order.map((s: number) => `#${s}`).join(' → ')}` : 'nothing to undo';
  if (e.eventType === 'verification.passed') detail = `read back v${p.observedVersion} matches original`;
  if (e.eventType === 'recovery.completed') detail = `${p.verified} verified · ${p.unresolvedSideEffects?.length ?? 0} unresolved`;
  return (
    <>
      <span className="font-medium">{EVENT_LABEL[e.eventType] ?? e.eventType}</span>
      {what && <span className="text-fg-2"> · {what}</span>}
      {detail && <span className="font-mono text-xs text-fg-3"> · {detail}</span>}
    </>
  );
}

function Verdict({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    recovered: { label: 'Recovered · verified', cls: 'bg-ok text-white' },
    partially_recovered: { label: 'Partially recovered', cls: 'bg-warn text-white' },
    recovery_failed: { label: 'Recovery failed', cls: 'bg-bad text-white' },
    succeeded: { label: 'Succeeded', cls: 'bg-ok text-white' },
    failed: { label: 'Failed · nothing to undo', cls: 'bg-fg text-bg' },
    awaiting_approval: { label: 'Waiting for approval', cls: 'bg-warn text-white' },
    cancelled: { label: 'Cancelled', cls: 'bg-fg text-bg' },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <motion.span initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className={cx('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', m.cls)}>
      {m.label}
    </motion.span>
  );
}
