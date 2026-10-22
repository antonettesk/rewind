import { ArrowLeft, Download, FileText, RotateCcw, ShieldAlert } from '../components/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, subscribe, type ActionView, type AuditEvent, type ExecutionView } from '../lib/api';
import { useRole } from '../lib/auth';
import { fmtDateTime, fmtDuration, fmtTime } from '../lib/format';
import { ACTION_STATUS, ATTEMPT_STATUS, CAPABILITY, EVENT_LABEL, eventTone, EXECUTION_STATUS, POLICY_DECISION, RECOVERY_OUTCOME, type Tone } from '../lib/strings';
import { RewindTheater } from '../components/RewindTheater';
import { Badge, Button, cx, Dialog, EmptyState, ErrorState, IdChip, Json, LabeledBadge, PageHeader, Provenance, Section, Skeleton, useToast } from '../components/ui';

type Selection = { kind: 'step'; id: string } | { kind: 'event'; seq: number } | null;

export function ExecutionPage() {
  const { id = '' } = useParams();
  const [view, setView] = useState<ExecutionView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Selection>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.execution(id);
      setView(v);
      setError(null);
      setSelected((s) => s ?? (v.execution.failureActionId ? { kind: 'step', id: v.execution.failureActionId } : v.actions[0] ? { kind: 'step', id: v.actions[0].id } : null));
    } catch (e) {
      setError(e);
    }
  }, [id]);

  useEffect(() => {
    setView(null);
    setSelected(null);
    void load();
  }, [load]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(`/executions/${encodeURIComponent(id)}/events`, () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 150);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [id, load]);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState title="Execution not found" action={<Link to="/app/executions" className="text-sm font-medium text-accent hover:underline">Back to executions</Link>}>
        No execution with ID <code className="font-mono">{id}</code> exists in this workspace. It may have been deleted by retention or a reset.
      </EmptyState>
    );
  }
  if (error && !view) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!view) return <InspectorSkeleton />;

  const e = view.execution;
  const step = selected?.kind === 'step' ? view.actions.find((a) => a.id === selected.id) : undefined;
  const event = selected?.kind === 'event' ? view.events.find((x) => x.seq === selected.seq) : undefined;

  return (
    <>
      <Link to="/app/executions" className="mb-3 inline-flex items-center gap-1 text-xs text-fg-2 hover:text-fg">
        <ArrowLeft className="size-3" aria-hidden /> Executions
      </Link>
      <PageHeader
        title={e.taskDescription.length > 90 ? `${e.taskDescription.slice(0, 90)}…` : e.taskDescription}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <LabeledBadge map={EXECUTION_STATUS} value={e.status} pulseWhen={['running', 'recovering']} />
            <IdChip id={e.id} />
            {e.metadata.demo ? <Badge tone="accent" dot={false}>Demo data</Badge> : null}
          </span>
        }
        actions={<HeaderActions view={view} onChange={setView} />}
      />

      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Created', fmtDateTime(e.createdAt)],
          ['Completed', fmtDateTime(e.completedAt)],
          ['Duration', fmtDuration(view.durationMs)],
          ['Steps', `${view.summary.succeeded} of ${view.summary.actionCount} succeeded`],
          ['Source', `${e.source} (${e.actor.type})`],
          ['Environment', `${e.environment} · ${[...new Set(view.actions.map((a) => a.adapterId))].join(', ') || '—'}`],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-fg-3">{k}</dt>
            <dd className="truncate" title={v}>{v}</dd>
          </div>
        ))}
      </dl>

      <Verdict view={view} />

      <div className="mt-6">
        <RewindTheater view={view} autoReplay={false} stepMs={420} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="space-y-6">
          <Section title="Steps" description="Click a step to inspect its inputs, outputs, state and recovery.">
            <ol className="divide-y divide-border">
              {view.actions.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSelected({ kind: 'step', id: a.id })}
                    aria-current={step?.id === a.id || undefined}
                    className={cx('flex w-full items-center gap-3 px-4 py-3 text-left', step?.id === a.id ? 'bg-accent-soft/60' : 'hover:bg-surface-2/60')}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs font-semibold text-fg-2 tabular">{a.sequence}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.operationTitle}</p>
                      <p className="truncate font-mono text-xs text-fg-3">{a.operationKey}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <LabeledBadge map={ACTION_STATUS} value={a.status} pulseWhen={['running']} />
                      <LabeledBadge map={RECOVERY_OUTCOME} value={a.recoveryOutcome} pulseWhen={['recovery_pending']} />
                    </div>
                  </button>
                </li>
              ))}
            </ol>
            {view.actions.length === 0 && <EmptyState title="No steps recorded">This execution has no steps yet.</EmptyState>}
          </Section>

          <Timeline events={view.events} truncated={view.eventsTruncated} actions={view.actions} selected={event?.seq} onSelect={(seq) => setSelected({ kind: 'event', seq })} />
        </div>

        <div className="xl:sticky xl:top-6 xl:self-start">
          {step ? <StepDetail a={step} execution={view} /> : event ? <EventDetail e={event} actions={view.actions} /> : <Section><EmptyState title="Select a step or event" /></Section>}
        </div>
      </div>
    </>
  );
}

function InspectorSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading execution">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

/** One plain-language sentence about what happened, built only from recorded facts. */
function Verdict({ view }: { view: ExecutionView }) {
  const e = view.execution;
  const failed = view.actions.find((a) => a.id === e.failureActionId);
  const compensated = view.actions.filter((a) => a.recoveryAttempts.length > 0);
  const verified = view.actions.filter((a) => a.recoveryOutcome === 'recovery_verified');
  const unresolved = view.summary.unresolved;
  let tone: Tone = 'neutral';
  const parts: string[] = [];
  if (e.status === 'succeeded') {
    tone = 'ok';
    parts.push(`All ${view.actions.length} steps succeeded. No recovery was needed.`);
  } else if (e.status === 'awaiting_approval') {
    tone = 'warn';
    const a = view.actions.find((x) => x.status === 'awaiting_approval');
    parts.push(`Paused: step ${a?.sequence} (${a?.operationTitle}) requires human approval before it runs.`);
  } else if (['running', 'pending'].includes(e.status)) {
    tone = 'info';
    parts.push('Execution is open.');
  } else if (e.status === 'recovering') {
    tone = 'info';
    parts.push('Recovery in progress. Results are not verified yet.');
  } else {
    if (failed) parts.push(`Step ${failed.sequence} (${failed.operationTitle}) ${failed.status === 'outcome_unknown' ? 'had an unknown outcome' : failed.status === 'denied' ? 'was denied' : 'failed'}: ${failed.errorMessage ?? e.failureReason}`);
    else if (e.failureReason) parts.push(e.failureReason);
    if (failed?.status === 'failed') parts.push('It did not apply its effect, so it needed no reversal.');
    if (compensated.length) parts.push(`Rewind attempted to compensate ${compensated.length} step${compensated.length > 1 ? 's' : ''} and verified ${verified.length} by reading the resource back.`);
    else if (view.recoveryRequests.length === 0 && unresolved.length === 0) parts.push('No earlier step had changed anything, so there was nothing to recover.');
    if (unresolved.length) {
      tone = e.status === 'recovery_failed' || e.status === 'failed' ? 'bad' : 'warn';
      parts.push(`${unresolved.length} effect${unresolved.length > 1 ? 's remain' : ' remains'} unresolved.`);
    } else if (e.status === 'recovered') {
      tone = 'ok';
      parts.push('Nothing remains unresolved.');
    } else if (e.status === 'failed') tone = 'bad';
  }
  const bg: Record<Tone, string> = { ok: 'border-ok/30 bg-ok-soft', warn: 'border-warn/30 bg-warn-soft', bad: 'border-bad/30 bg-bad-soft', info: 'border-info/30 bg-info-soft', neutral: 'border-border bg-surface-2', accent: 'border-accent/30 bg-accent-soft' };
  return (
    <div className={cx('rounded-lg border px-4 py-3', bg[tone])} role="status">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm leading-relaxed">{parts.join(' ')}</p>
        <Provenance kind="derived" />
      </div>
      {unresolved.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {unresolved.map((u) => (
            <li key={u.actionId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">#{u.sequence} {u.operationKey}</span>
              <LabeledBadge map={RECOVERY_OUTCOME} value={u.outcome} />
              <span className="text-fg-2">{u.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HeaderActions({ view, onChange }: { view: ExecutionView; onChange: (v: ExecutionView) => void }) {
  const toast = useToast();
  const { can } = useRole();
  const [dialog, setDialog] = useState<null | 'recover' | 'approve' | 'reject' | 'cancel'>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const e = view.execution;
  const pending = view.actions.find((a) => a.status === 'awaiting_approval');
  const retry = view.summary.retry;
  const recoverLabel = view.recoveryRequests.length ? 'Retry recovery' : 'Request recovery';

  async function act(fn: () => Promise<ExecutionView>, success: string) {
    setBusy(true);
    setErr(null);
    try {
      const v = await fn();
      onChange(v);
      setDialog(null);
      setReason('');
      toast.push({ tone: EXECUTION_STATUS[v.execution.status]?.tone ?? 'neutral', title: success, body: `Execution is now ${EXECUTION_STATUS[v.execution.status]?.label ?? v.execution.status}.` });
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <a href={api.reportUrl(e.id, 'md')} target="_blank" rel="noreferrer">
        <Button size="sm" icon={<FileText className="size-3.5" aria-hidden />}>Report</Button>
      </a>
      <a href={api.reportUrl(e.id, 'json')} download>
        <Button size="sm" icon={<Download className="size-3.5" aria-hidden />}>Export JSON</Button>
      </a>
      {pending && !can('admin') && <Badge tone="warn">Waiting for an admin to approve step {pending.sequence}</Badge>}
      {pending && can('admin') && (
        <>
          <Button size="sm" variant="primary" onClick={() => setDialog('approve')}>Approve step {pending.sequence}</Button>
          <Button size="sm" onClick={() => setDialog('reject')}>Reject</Button>
        </>
      )}
      {['pending', 'running'].includes(e.status) && e.metadata.mode === 'agent' && (
        <Button size="sm" onClick={() => setDialog('cancel')}>Cancel execution</Button>
      )}
      {retry.available && can('member') && (
        <Button size="sm" variant="primary" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setDialog('recover')} title={retry.reason}>
          {recoverLabel}
        </Button>
      )}

      <Dialog
        open={dialog === 'recover'}
        onClose={() => setDialog(null)}
        title={`${recoverLabel}?`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => act(() => api.recover(e.id, `ui-${Date.now()}`), 'Recovery finished')}>
              {recoverLabel}
            </Button>
          </>
        }
      >
        <p>{retry.reason}</p>
        <p className="mt-2">Rewind re-checks each resource before writing and refuses to overwrite a change made by someone else. Steps already verified are not touched again. Irreversible effects stay as they are.</p>
        {err && <p className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">{err}</p>}
      </Dialog>

      <Dialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title={`Approve step ${pending?.sequence}: ${pending?.operationTitle}?`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => pending && act(() => api.approve(e.id, pending.id), 'Step approved')}>
              Approve and run
            </Button>
          </>
        }
      >
        {pending && (
          <>
            <p>{pending.policy.reason}</p>
            <div className="mt-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Recovery capability: <strong>{CAPABILITY[pending.capability]?.label}</strong>. {pending.recoverySummary}
              </span>
            </div>
            <p className="mb-1 mt-3 text-xs font-medium text-fg-3">Input</p>
            <Json value={pending.input} />
          </>
        )}
        {err && <p className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">{err}</p>}
      </Dialog>

      <Dialog
        open={dialog === 'reject' || dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title={dialog === 'reject' ? 'Reject this step?' : 'Cancel this execution?'}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Back</Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => act(() => (dialog === 'reject' && pending ? api.reject(e.id, pending.id, reason) : api.cancel(e.id, reason)), dialog === 'reject' ? 'Step rejected' : 'Execution cancelled')}
            >
              {dialog === 'reject' ? 'Reject step' : 'Cancel execution'}
            </Button>
          </>
        }
      >
        <p>The execution stops. Earlier steps that changed something are compensated if policy allows automatic recovery.</p>
        <label className="mt-3 block">
          <span className="text-xs font-medium text-fg-2">Reason (recorded in the audit trail)</span>
          <input value={reason} onChange={(x) => setReason(x.target.value)} maxLength={200} className="mt-1 h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-fg outline-none focus:border-accent" />
        </label>
        {err && <p className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">{err}</p>}
      </Dialog>
    </>
  );
}

const PHASES: { id: string; label: string; match: (e: AuditEvent) => boolean }[] = [
  { id: 'plan', label: 'Plan & policy', match: (e) => ['execution.created', 'action.planned', 'policy.evaluated', 'execution.idempotent_replay'].includes(e.eventType) && !e.payload.reEvaluated },
  { id: 'recovery', label: 'Recovery', match: (e) => /^(recovery|compensation|verification|reconciliation)\./.test(e.eventType) },
  { id: 'forward', label: 'Execution', match: () => true },
];

function phaseOf(e: AuditEvent, inRecovery: boolean, started: boolean) {
  // Once forward execution starts, per-step planning events belong to the execution phase.
  if (!started && PHASES[0]!.match(e)) return 'plan';
  if (inRecovery || PHASES[1]!.match(e)) return 'recovery';
  return 'forward';
}

function Timeline({ events, truncated, actions, selected, onSelect }: { events: AuditEvent[]; truncated: boolean; actions: ActionView[]; selected?: number; onSelect: (seq: number) => void }) {
  const [showAll, setShowAll] = useState(false);
  const seqOf = useMemo(() => new Map(actions.map((a) => [a.id, a.sequence])), [actions]);
  const visible = showAll ? events : events.filter((e) => e.eventType !== 'snapshot.captured' && e.eventType !== 'execution.status_changed');
  let inRecovery = false;
  let started = false;
  const groups: { phase: string; events: AuditEvent[] }[] = [];
  for (const e of visible) {
    if (e.eventType === 'recovery.requested' || e.eventType === 'recovery.not_required' || e.eventType === 'recovery.awaiting_request') inRecovery = true;
    if (e.eventType === 'action.started' || e.eventType === 'approval.requested') started = true;
    const p = phaseOf(e, inRecovery && e.eventType !== 'execution.halted', started);
    const last = groups.at(-1);
    if (last?.phase === p) last.events.push(e);
    else groups.push({ phase: p, events: [e] });
  }
  return (
    <Section
      title="Timeline"
      description="Append-only audit events in the order they were recorded."
      actions={
        <label className="flex items-center gap-1.5 text-xs text-fg-2">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
          Show snapshots &amp; status changes
        </label>
      }
    >
      <div className="px-4 py-3">
        {groups.map((g, gi) => (
          <div key={gi} className="mb-3 last:mb-0">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-3">{PHASES.find((p) => p.id === g.phase)?.label}</p>
            <ol className="relative ml-1.5 border-l border-border">
              {g.events.map((e) => {
                const tone = eventTone(e.eventType);
                const seq = typeof e.payload.actionId === 'string' ? seqOf.get(e.payload.actionId) : undefined;
                return (
                  <li key={e.seq}>
                    <button
                      type="button"
                      onClick={() => onSelect(e.seq)}
                      aria-current={selected === e.seq || undefined}
                      className={cx('group relative flex w-full items-start gap-3 rounded-r-md py-1.5 pl-4 pr-2 text-left', selected === e.seq ? 'bg-accent-soft/60' : 'hover:bg-surface-2/60')}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          'absolute -left-[5px] top-[11px] size-2.5 rounded-full border-2 border-surface',
                          { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-fg-3', accent: 'bg-accent' }[tone],
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">
                          {EVENT_LABEL[e.eventType] ?? e.eventType}
                          {seq !== undefined && <span className="ml-1.5 text-xs text-fg-3">step {seq}</span>}
                        </span>
                        <span className="block truncate text-xs text-fg-3">{describe(e)}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-3 tabular">{fmtTime(e.timestamp)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
        {truncated && <p className="text-xs text-fg-3">Timeline truncated. Export the JSON report for the full trace.</p>}
      </div>
    </Section>
  );
}

function describe(e: AuditEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.eventType) {
    case 'policy.evaluated':
      return `${p.operation}: ${POLICY_DECISION[p.decision]?.label ?? p.decision}. ${p.reason ?? ''}`;
    case 'action.failed':
    case 'action.outcome_unknown':
      return `${p.error?.code}: ${p.error?.message}`;
    case 'action.retry_scheduled':
      return `Attempt ${p.attempt} had no effect (${p.error?.code}); retrying.`;
    case 'recovery.planned':
      return p.order?.length ? `Compensate in order: ${p.order.map((s: number) => `#${s}`).join(' → ')}` : 'Nothing eligible to compensate.';
    case 'recovery.completed':
      return `Outcome ${p.outcome}; ${p.verified} verified; ${p.unresolvedSideEffects?.length ?? 0} unresolved.`;
    case 'compensation.failed':
    case 'compensation.conflict':
      return p.error?.message ?? p.reason ?? `expected v${p.expectedVersion}, found v${p.observedVersion}`;
    case 'verification.failed':
      return `${p.diffs?.length ?? 0} field(s) differ from the captured original.`;
    case 'verification.passed':
      return `Read back v${p.observedVersion}: matches the captured original.`;
    case 'reconciliation.completed':
      return `Effect ${p.result === 'applied' ? 'did apply' : p.result === 'not_applied' ? 'did not apply' : 'could not be determined'}.`;
    case 'snapshot.captured':
      return `${p.phase} · ${p.resource} v${p.version}`;
    case 'execution.status_changed':
      return `${p.from} → ${p.to}`;
    case 'execution.halted':
      return p.reason ?? '';
    case 'approval.granted':
      return `by ${p.approvedBy}`;
    default:
      return p.operation ?? p.reason ?? '';
  }
}

function StepDetail({ a, execution }: { a: ActionView; execution: ExecutionView }) {
  const hasState = a.kind === 'mutation';
  return (
    <Section
      title={
        <span className="flex flex-wrap items-center gap-2">
          Step {a.sequence} · {a.operationTitle}
        </span>
      }
      description={<span className="font-mono">{a.operationKey}</span>}
    >
      <div className="space-y-5 p-4">
        <div className="flex flex-wrap gap-1.5">
          <LabeledBadge map={ACTION_STATUS} value={a.status} />
          <LabeledBadge map={CAPABILITY} value={a.capability} />
          <LabeledBadge map={RECOVERY_OUTCOME} value={a.recoveryOutcome} />
        </div>

        <Field title="Recovery outcome" kind="derived">
          <p className="text-sm">{a.recoveryOutcomeReason}</p>
          <p className="mt-1 text-xs text-fg-3">Declared strategy: {a.recoverySummary}</p>
        </Field>

        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          {[
            ['Started', fmtTime(a.startedAt)],
            ['Completed', fmtTime(a.completedAt)],
            ['Duration', fmtDuration(a.durationMs)],
            ['Forward attempts', String(a.forwardAttempts)],
            ['Adapter', a.adapterId],
            ['Resource', `${a.resourceType}/${a.resourceId}`],
            ['Depends on', a.dependsOn === null ? 'previous step' : a.dependsOn.length ? a.dependsOn.map((d) => `#${d}`).join(', ') : 'independent'],
            ['Dedupe key', a.dedupeKey ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-fg-3">{k}</dt>
              <dd className="truncate font-mono" title={v}>{v}</dd>
            </div>
          ))}
        </dl>

        <Field title="Policy decision" kind="recorded">
          <div className="flex items-center gap-2 text-sm">
            <LabeledBadge map={POLICY_DECISION} value={a.policy.decision} />
            <span className="text-fg-2">{a.policy.reason}</span>
          </div>
          {a.policy.matched.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs text-fg-3">
              {a.policy.matched.map((m, i) => (
                <li key={i}>
                  {m.policyName} · <code>{m.pattern}</code> → {m.effect}
                </li>
              ))}
            </ul>
          )}
          {a.approvedBy && <p className="mt-1 text-xs text-fg-2">Approved by {a.approvedBy}</p>}
        </Field>

        {a.errorCode && (
          <Field title="Error" kind="recorded">
            <div className="rounded-md bg-bad-soft px-3 py-2 text-sm">
              <p className="font-mono text-xs font-semibold text-bad">{a.errorCode}</p>
              <p className="mt-0.5 text-fg">{a.errorMessage}</p>
              <p className="mt-1 text-xs text-fg-2">
                Effect certainty: <strong>{a.errorEffect ?? 'unknown'}</strong>
                {a.errorEffect === 'none' && ' — the adapter reported nothing changed.'}
                {a.errorEffect === 'unknown' && ' — Rewind cannot tell whether it changed anything, so it never retries blindly.'}
              </p>
              {a.reconciliation && <p className="mt-1 text-xs text-fg-2">Reconciliation by read-back: <strong>{a.reconciliation.replace('_', ' ')}</strong></p>}
            </div>
          </Field>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field title="Input" kind="recorded">
            <Json value={a.input} />
          </Field>
          <Field title="Result" kind={a.result === null ? 'unavailable' : 'recorded'}>
            {a.result === null ? <p className="text-xs text-fg-3">No result: the step did not complete successfully.</p> : <Json value={a.result} />}
          </Field>
        </div>

        {hasState && <StateCompare a={a} />}

        <Field title="Recovery attempts" kind={a.recoveryAttempts.length ? 'recorded' : 'unavailable'}>
          {a.recoveryAttempts.length ? (
            <ol className="space-y-2">
              {a.recoveryAttempts.map((t) => (
                <li key={t.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Attempt {t.attemptNumber}</span>
                    <LabeledBadge map={ATTEMPT_STATUS} value={t.status} />
                    <span className="text-xs text-fg-3">{t.strategy} · {fmtTime(t.startedAt)} → {fmtTime(t.completedAt)}</span>
                  </div>
                  {t.errorCode && (
                    <p className="mt-1 text-xs text-fg-2">
                      <code className="text-bad">{t.errorCode}</code> {t.errorMessage}
                    </p>
                  )}
                  {t.verification && (
                    <div className="mt-2 text-xs">
                      <p className={t.verification.restored ? 'text-ok' : 'text-bad'}>
                        Verification by read-back (v{t.verification.observedVersion}): {t.verification.restored ? 'matches the captured original' : `${t.verification.diffs.length} field(s) differ`}
                      </p>
                      {!t.verification.restored && (
                        <ul className="mt-1 space-y-0.5 font-mono">
                          {t.verification.diffs.map((d) => (
                            <li key={d.path}>
                              {d.path}: expected {JSON.stringify(d.expected)}, observed {JSON.stringify(d.observed)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-fg-3">{a.kind === 'read' ? 'Read-only step.' : execution.execution.status === 'succeeded' ? 'Not needed: the execution succeeded.' : 'No compensation was attempted for this step.'}</p>
          )}
        </Field>
      </div>
    </Section>
  );
}

function flatten(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(v)) {
    if (v.length === 0) out[prefix] = '[]';
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  } else out[prefix] = v;
  return out;
}

function StateCompare({ a }: { a: ActionView }) {
  const before = a.snapshots.before?.capturedState;
  const after = a.snapshots.after?.capturedState ?? a.snapshots.reconciliation?.capturedState;
  const final = a.snapshots.verification?.capturedState;
  if (!before) {
    return (
      <Field title="State" kind="unavailable">
        <p className="text-xs text-fg-3">No snapshot was captured for this step.</p>
      </Field>
    );
  }
  const fb = flatten(before.data);
  const fa = after ? flatten(after.data) : {};
  const ff = final ? flatten(final.data) : {};
  const keys = [...new Set([...Object.keys(fb), ...Object.keys(fa), ...Object.keys(ff)])];
  const show = (x: unknown) => (x === undefined ? '—' : typeof x === 'string' ? x : JSON.stringify(x));
  return (
    <Field title="State: original → after step → after recovery" kind="recorded">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[480px] text-xs">
          <thead className="bg-surface-2 text-left text-fg-2">
            <tr>
              <th scope="col" className="px-2.5 py-1.5 font-medium">Field</th>
              <th scope="col" className="px-2.5 py-1.5 font-medium">Original <span className="font-mono text-fg-3">v{before.version}</span></th>
              <th scope="col" className="px-2.5 py-1.5 font-medium">After step {after && <span className="font-mono text-fg-3">v{after.version}</span>}</th>
              <th scope="col" className="px-2.5 py-1.5 font-medium">After recovery {final && <span className="font-mono text-fg-3">v{final.version}</span>}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border font-mono">
            {keys.map((k) => {
              const changed = after && show(fa[k]) !== show(fb[k]);
              const restored = final ? show(ff[k]) === show(fb[k]) : null;
              return (
                <tr key={k}>
                  <td className="px-2.5 py-1.5 text-fg-2">{k}</td>
                  <td className="px-2.5 py-1.5">{show(fb[k])}</td>
                  <td className={cx('px-2.5 py-1.5', changed && 'bg-warn-soft text-warn')}>{after ? show(fa[k]) : '—'}</td>
                  <td className={cx('px-2.5 py-1.5', restored === true && changed && 'bg-ok-soft text-ok', restored === false && 'bg-bad-soft text-bad')}>{final ? show(ff[k]) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-fg-3">
        Snapshots are read from the adapter and stored with a SHA-256 of their canonical JSON ({a.snapshots.before?.sha256.slice(0, 12)}…). The hash detects accidental corruption; it is not a tamper-proof seal.
        {!final && ' No post-recovery snapshot exists for this step.'}
      </p>
    </Field>
  );
}

function EventDetail({ e, actions }: { e: AuditEvent; actions: ActionView[] }) {
  const a = typeof e.payload.actionId === 'string' ? actions.find((x) => x.id === e.payload.actionId) : undefined;
  return (
    <Section title={EVENT_LABEL[e.eventType] ?? e.eventType} description={<span className="font-mono">{e.eventType}</span>}>
      <div className="space-y-4 p-4">
        <dl className="grid grid-cols-2 gap-3 text-xs">
          {[
            ['Recorded at', fmtDateTime(e.timestamp)],
            ['Sequence', String(e.seq)],
            ['Actor', `${e.actor.type} · ${e.actor.label}`],
            ['Step', a ? `#${a.sequence} ${a.operationTitle}` : '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-fg-3">{k}</dt>
              <dd className="font-mono">{v}</dd>
            </div>
          ))}
        </dl>
        <Field title="Payload" kind="recorded">
          <Json value={e.payload} className="max-h-[32rem]" />
        </Field>
        <p className="font-mono text-[11px] text-fg-3">payload sha256 {e.payloadSha256}</p>
      </div>
    </Section>
  );
}

function Field({ title, kind, children }: { title: string; kind: 'recorded' | 'derived' | 'unavailable'; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold text-fg-2">{title}</h3>
        <Provenance kind={kind} />
      </div>
      {children}
    </div>
  );
}
