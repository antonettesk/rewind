/**
 * The landing-page playground. Visitors configure a failure and press Run; the
 * outcome is computed by Rewind's real, deterministic recovery planner
 * (src/domain/recovery-plan.ts), the same code the server engine uses. Only the
 * adapters are simulated (in the browser): which writes succeed, fail, time out,
 * or get edited by someone else.
 */
import { Check, CircleSlash, Launch, ListChecks, MessageSquare, Play, RotateCcw, Shield, Thermometer, TriangleAlert, X } from '../../components/icons';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { planRecovery, summarizeRecovery, transitiveDependencies, type PlannableAction } from '../../../../src/domain/recovery-plan';
import { cx } from '../../components/ui';

type Cap = 'compensatable' | 'irreversible';
interface StepDef {
  key: string;
  title: string;
  icon: typeof Thermometer;
  capability: Cap;
  optional?: boolean;
}

const STEPS: StepDef[] = [
  { key: 'thermo', title: 'Thermostat → away', icon: Thermometer, capability: 'compensatable' },
  { key: 'tasks', title: 'Update task list', icon: ListChecks, capability: 'compensatable' },
  { key: 'notify', title: 'Text the household', icon: MessageSquare, capability: 'irreversible', optional: true },
  { key: 'security', title: 'Arm security', icon: Shield, capability: 'compensatable' },
];

type Visual = 'idle' | 'running' | 'done' | 'failed' | 'unknown' | 'skipped' | 'rewinding' | 'verified' | 'conflict' | 'unavailable' | 'blocked';
type Frame = { log: string; tone: 'dim' | 'ok' | 'bad' | 'warn' | 'accent'; set?: [number, Visual][]; head?: { at: number; dir: 'fwd' | 'back' } };

const VISUAL: Record<Visual, { ring: string; label: string; chip: string }> = {
  idle: { ring: 'border-white/10', label: 'waiting', chip: 'text-white/40' },
  running: { ring: 'border-sky-400/70 shadow-[0_0_30px_-6px] shadow-sky-400/60', label: 'running…', chip: 'text-sky-300' },
  done: { ring: 'border-emerald-400/50', label: 'applied · state captured', chip: 'text-emerald-300' },
  failed: { ring: 'border-rose-500 shadow-[0_0_34px_-6px] shadow-rose-500/70', label: 'failed · no effect', chip: 'text-rose-300' },
  unknown: { ring: 'border-amber-400 shadow-[0_0_30px_-8px] shadow-amber-400/60', label: 'timed out · outcome unknown', chip: 'text-amber-300' },
  skipped: { ring: 'border-white/5 opacity-40', label: 'never ran', chip: 'text-white/40' },
  rewinding: { ring: 'border-cyan-300 shadow-[0_0_36px_-4px] shadow-cyan-300/70', label: 'compensating…', chip: 'text-cyan-200' },
  verified: { ring: 'border-cyan-300/70', label: 'restored · verified', chip: 'text-cyan-200' },
  conflict: { ring: 'border-amber-400', label: 'changed by someone else', chip: 'text-amber-300' },
  unavailable: { ring: 'border-rose-400/60', label: 'cannot be undone', chip: 'text-rose-300' },
  blocked: { ring: 'border-amber-400/40', label: 'left in place (dependency)', chip: 'text-amber-200' },
};

export function Playground() {
  const [includeNotify, setIncludeNotify] = useState(false);
  const steps = useMemo(() => STEPS.filter((s) => !s.optional || includeNotify), [includeNotify]);
  const [failAt, setFailAt] = useState(steps.length - 1);
  const [failMode, setFailMode] = useState<'error' | 'timeout'>('error');
  const [drift, setDrift] = useState<Set<string>>(new Set());
  const [frames, setFrames] = useState<Frame[]>([]);
  const [shown, setShown] = useState(0);
  const [verdict, setVerdict] = useState<{ status: string; line: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => setFailAt((f) => Math.min(f, steps.length - 1)), [steps.length]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (shown >= frames.length) return;
    timer.current = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 120 : 620);
    return () => clearTimeout(timer.current);
  }, [shown, frames.length]);
  useEffect(() => {
    // Scroll the log box only; never the page.
    const el = logRef.current;
    if (el && shown > 0) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const visuals = new Map<number, Visual>();
  let head: Frame['head'] | undefined;
  for (const f of frames.slice(0, shown)) {
    f.set?.forEach(([i, v]) => visuals.set(i, v));
    if (f.head) head = f.head;
  }
  const playing = shown < frames.length;
  const finished = frames.length > 0 && !playing;

  function run() {
    clearTimeout(timer.current);
    const fr: Frame[] = [{ log: `agent → create_execution · ${steps.length} steps`, tone: 'dim' }];
    // Forward path, simulated adapters.
    const plannable: PlannableAction[] = steps.map((s, i) => ({
      id: s.key,
      sequence: i + 1,
      status: i < failAt ? 'succeeded' : i === failAt ? (failMode === 'timeout' ? 'outcome_unknown' : 'failed') : 'skipped',
      kind: 'mutation',
      capability: s.capability,
      idempotentCompensation: s.capability === 'compensatable',
      // Independent steps; the last step depends on everything before it (like the real demo).
      dependsOn: s.key === 'security' ? steps.slice(0, i).map((_, k) => k + 1) : [],
      reconciliation: i === failAt && failMode === 'timeout' ? 'applied' : undefined,
      attempts: [],
    }));
    steps.forEach((s, i) => {
      if (i > failAt) return;
      fr.push({ log: `policy ✓ · lease · snapshot before · ${s.title}`, tone: 'dim', set: [[i, 'running']], head: { at: i, dir: 'fwd' } });
      if (i < failAt) fr.push({ log: `✓ ${s.title} applied · snapshot after`, tone: 'ok', set: [[i, 'done']] });
    });
    const failing = steps[failAt]!;
    if (failMode === 'timeout') {
      fr.push({ log: `⏱ ${failing.title}: no response in 1500 ms → outcome UNKNOWN (never retried blindly)`, tone: 'warn', set: [[failAt, 'unknown']] });
      fr.push({ log: `↺ reconcile by read-back: state equals expectedAfter → effect APPLIED`, tone: 'accent' });
    } else {
      fr.push({ log: `✗ ${failing.title}: rejected by the device · effect: none`, tone: 'bad', set: [[failAt, 'failed']] });
    }
    const skippedSets: [number, Visual][] = steps.map((_, i) => [i, 'skipped'] as [number, Visual]).filter(([i]) => i > failAt);
    fr.push({ log: `■ halt: ${steps.length - failAt - 1} remaining step(s) skipped`, tone: 'dim', set: skippedSets });

    // The real planner decides.
    const plan = planRecovery(plannable, { maxAttempts: 3, allowRetry: true });
    fr.push({
      log: plan.compensations.length ? `planner → undo order ${plan.compensations.map((c) => `#${c.sequence}`).join(' → ')}` : 'planner → nothing eligible to compensate',
      tone: 'accent',
    });
    plan.steps.filter((p) => p.decision === 'unavailable').forEach((p) => fr.push({ log: `⚠ #${p.sequence} ${steps[p.sequence - 1]!.title}: ${p.reason}`, tone: 'bad', set: [[p.sequence - 1, 'unavailable']] }));

    const final = new Map<string, 'verified' | 'conflict'>();
    const blocked = new Set<number>();
    for (const c of plan.compensations) {
      const i = c.sequence - 1;
      const s = steps[i]!;
      if (blocked.has(c.sequence)) {
        fr.push({ log: `⤫ #${c.sequence} ${s.title}: left in place, a later step that depends on it could not be restored`, tone: 'warn', set: [[i, 'blocked']] });
        continue;
      }
      fr.push({ log: `⟲ compensate #${c.sequence} ${s.title} (compare-and-set on written version)`, tone: 'accent', set: [[i, 'rewinding']], head: { at: i, dir: 'back' } });
      if (drift.has(s.key)) {
        final.set(s.key, 'conflict');
        fr.push({ log: `⚠ #${c.sequence} version moved since Rewind wrote it → refuse to overwrite → manual review`, tone: 'warn', set: [[i, 'conflict']] });
        transitiveDependencies(plannable, c.sequence).forEach((d) => blocked.add(d));
      } else {
        final.set(s.key, 'verified');
        fr.push({ log: `✓ #${c.sequence} read back · matches captured original → VERIFIED`, tone: 'ok', set: [[i, 'verified']] });
      }
    }
    const outcome = summarizeRecovery(plan.steps.map((p) => ({ decision: p.decision, finalStatus: final.get(p.actionId) })));
    const needed = plan.steps.filter((p) => p.decision !== 'not_required').length;
    const lines: Record<string, string> = {
      recovered: needed ? 'Every effect that needed undoing was restored and verified.' : 'Nothing had changed yet, so there was nothing to undo.',
      partially_recovered: 'Some effects were restored and verified; the rest are reported as unresolved.',
      recovery_failed: 'Nothing could be safely restored. Every remaining effect is reported for a human.',
    };
    fr.push({ log: `recovery.completed → ${outcome}`, tone: outcome === 'recovered' ? 'ok' : 'warn' });
    setVerdict({ status: outcome, line: lines[outcome]! });
    setFrames(fr);
    setShown(0);
  }

  const reset = () => {
    clearTimeout(timer.current);
    setFrames([]);
    setShown(0);
    setVerdict(null);
  };

  const n = steps.length;
  const pct = (i: number) => ((i + 0.5) / n) * 100;

  return (
    <div className="relative overflow-clip rounded-3xl border border-white/10 bg-[#0b0c10] p-4 shadow-2xl shadow-indigo-950/40 sm:p-6">
      <div className="pointer-events-none absolute -inset-px rounded-3xl bg-[linear-gradient(120deg,rgba(129,140,248,.35),transparent_30%,transparent_70%,rgba(34,211,238,.35))] opacity-60 [mask:linear-gradient(#000,#000)_content-box,linear-gradient(#000,#000)] [mask-composite:exclude] p-px" aria-hidden />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px] shadow-emerald-400" aria-hidden />
          <p className="text-sm font-semibold text-white">Recovery playground</p>
          <span className="hidden rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-white/50 sm:inline">runs src/domain/recovery-plan.ts in your browser</span>
        </div>
        <div className="flex items-center gap-2">
          {finished && (
            <button type="button" onClick={reset} className="rounded-lg px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white">
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={run}
            disabled={playing}
            className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black transition hover:scale-[1.02] disabled:opacity-60"
          >
            <span className="absolute inset-0 -translate-x-full bg-[linear-gradient(90deg,transparent,rgba(99,102,241,.25),transparent)] transition-transform duration-700 group-hover:translate-x-full" aria-hidden />
            {playing ? <RotateCcw className="size-4 animate-spin [animation-direction:reverse]" aria-hidden /> : <Play className="size-4" aria-hidden />}
            {playing ? 'Running…' : finished ? 'Run again' : 'Run'}
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="mt-5 grid grid-cols-1 gap-3 text-xs text-white/70 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-3">
          <p className="mb-2 font-medium text-white/80">1 · Click the step that fails</p>
          <div className="flex flex-wrap gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setFailAt(i);
                  reset();
                }}
                aria-pressed={failAt === i}
                className={cx('rounded-lg border px-2.5 py-1.5 transition', failAt === i ? 'border-rose-400/60 bg-rose-500/15 text-rose-200' : 'border-white/10 hover:border-white/25 hover:text-white')}
              >
                {s.title}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-white/50">It fails with</span>
            {(['error', 'timeout'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={failMode === m}
                onClick={() => {
                  setFailMode(m);
                  reset();
                }}
                className={cx('rounded-full border px-2.5 py-1', failMode === m ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 text-white/60 hover:text-white')}
              >
                {m === 'error' ? 'an error (nothing changed)' : 'a timeout (it did change)'}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-3">
          <p className="mb-2 font-medium text-white/80">2 · Make it harder</p>
          <label className="flex cursor-pointer items-center gap-2 py-1">
            <input
              type="checkbox"
              checked={includeNotify}
              onChange={(e) => {
                setIncludeNotify(e.target.checked);
                // Keep the failure on the last step, so earlier steps (including the text) run first.
                setFailAt(STEPS.filter((x) => !x.optional || e.target.checked).length - 1);
                reset();
              }}
              className="size-4 accent-indigo-400"
            />
            Send an irreversible text along the way
          </label>
          <label className="flex cursor-pointer items-center gap-2 py-1">
            <input
              type="checkbox"
              checked={drift.has('tasks')}
              onChange={(e) => {
                setDrift((d) => {
                  const x = new Set(d);
                  if (e.target.checked) x.add('tasks');
                  else x.delete('tasks');
                  return x;
                });
                reset();
              }}
              className="size-4 accent-indigo-400"
            />
            A family member edits the task list mid-run
          </label>
        </div>
      </div>

      {/* Track */}
      <div className="relative mt-3 overflow-x-auto pb-2 pt-3">
        <div className="relative mx-auto min-w-[calc(var(--n)*100px)] sm:min-w-[calc(var(--n)*150px)]" style={{ ['--n' as string]: n }}>
          <div className="absolute left-0 right-0 top-[32px] h-px sm:top-[44px] bg-white/10" aria-hidden />
          <AnimatePresence>
            {head && (
              <motion.div
                key="head"
                className={cx('absolute top-[27px] z-20 size-[11px] sm:top-[39px] rounded-full', head.dir === 'fwd' ? 'bg-emerald-300 shadow-[0_0_18px_4px] shadow-emerald-400/70' : 'bg-cyan-200 shadow-[0_0_22px_6px] shadow-cyan-300/80')}
                initial={false}
                animate={{ left: `calc(${pct(head.at)}% - 5px)` }}
                transition={{ type: 'spring', stiffness: 110, damping: 18 }}
                aria-hidden
              />
            )}
          </AnimatePresence>
          <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {steps.map((s, i) => {
              const v = visuals.get(i) ?? 'idle';
              const st = VISUAL[v];
              return (
                <li key={s.key} className="flex flex-col items-center px-1.5 text-center">
                  <motion.button
                    type="button"
                    onClick={() => {
                      setFailAt(i);
                      reset();
                    }}
                    title="Make this the step that fails"
                    animate={v === 'failed' ? { x: [0, -6, 6, -3, 3, 0] } : v === 'rewinding' ? { rotate: [0, -10, 0], scale: [1, 1.06, 1] } : { x: 0, rotate: 0, scale: 1 }}
                    transition={{ duration: 0.45 }}
                    className={cx('relative z-10 flex size-16 items-center justify-center rounded-[18px] sm:size-[88px] sm:rounded-[22px] border-2 bg-[#111218] transition-[border-color,box-shadow,opacity] duration-500', st.ring, failAt === i && v === 'idle' && 'border-dashed border-rose-400/50')}
                  >
                    <s.icon className={cx('size-6 transition-colors sm:size-8 duration-500', v === 'idle' || v === 'skipped' ? 'text-white/40' : 'text-white')} aria-hidden />
                    <Mark v={v} />
                  </motion.button>
                  <p className="mt-3 text-[12px] font-medium leading-tight text-white sm:text-[13px]">{s.title}</p>
                  <p className={cx('mt-0.5 text-[10px] uppercase tracking-wider', s.capability === 'irreversible' ? 'text-rose-300/70' : 'text-white/35')}>{s.capability}</p>
                  <p className={cx('mt-1.5 min-h-[16px] text-[11px] font-medium transition-colors', st.chip)}>{st.label}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Log + verdict */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.6fr_1fr]">
        <ol ref={logRef} className="h-44 overflow-y-auto rounded-2xl border border-white/10 bg-black/50 p-3 font-mono text-[11.5px] leading-relaxed" aria-live="polite" aria-label="Recovery log">
          {frames.length === 0 && <li className="text-white/40">$ press Run. The planner decides what to undo, in what order, and what it must not touch.</li>}
          {frames.slice(0, shown).map((f, i) => (
            <motion.li
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              className={{ dim: 'text-white/50', ok: 'text-emerald-300', bad: 'text-rose-300', warn: 'text-amber-300', accent: 'text-cyan-200' }[f.tone]}
            >
              <span className="mr-2 text-white/25">{String(i + 1).padStart(2, '0')}</span>
              {f.log}
            </motion.li>
          ))}
        </ol>
        <div className="flex flex-col justify-center rounded-2xl border border-white/10 bg-white/[.03] p-4">
          <AnimatePresence mode="wait">
            {finished && verdict ? (
              <motion.div key="v" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
                <span
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                    verdict.status === 'recovered' ? 'bg-emerald-400/15 text-emerald-300' : verdict.status === 'partially_recovered' ? 'bg-amber-400/15 text-amber-300' : 'bg-rose-500/15 text-rose-300',
                  )}
                >
                  {verdict.status === 'recovered' ? <Check className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
                  {verdict.status.replace('_', ' ')}
                </span>
                <p className="mt-3 text-sm text-white/80">{verdict.line}</p>
                <p className="mt-2 text-xs text-white/40">Same planner as the server engine. In the live demo, every write and read-back is real.</p>
              </motion.div>
            ) : (
              <motion.div key="w" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-white/50">
                <Launch className="mb-2 size-5 text-indigo-300" aria-hidden />
                {playing ? 'Watching the engine…' : 'Configure a failure, then press Run. Try a timeout, an irreversible text, or a concurrent edit.'}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function Mark({ v }: { v: Visual }) {
  const m: Partial<Record<Visual, { icon: typeof Check; cls: string }>> = {
    done: { icon: Check, cls: 'bg-emerald-400 text-black' },
    verified: { icon: RotateCcw, cls: 'bg-cyan-300 text-black' },
    failed: { icon: X, cls: 'bg-rose-500 text-white' },
    unknown: { icon: TriangleAlert, cls: 'bg-amber-400 text-black' },
    conflict: { icon: TriangleAlert, cls: 'bg-amber-400 text-black' },
    unavailable: { icon: CircleSlash, cls: 'bg-rose-400 text-black' },
    blocked: { icon: CircleSlash, cls: 'bg-amber-300 text-black' },
  };
  const x = m[v];
  return (
    <AnimatePresence>
      {x && (
        <motion.span key={v} initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 18 }} className={cx('absolute -right-2 -top-2 flex size-7 items-center justify-center rounded-full border-[3px] border-[#0b0c10]', x.cls)}>
          <x.icon className="size-3.5" aria-hidden />
        </motion.span>
      )}
    </AnimatePresence>
  );
}
