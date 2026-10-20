import { AgentMark, ArrowRight, CircleAlert, Home, Mic, PlayCircle, RotateCcw, Terminal } from '../components/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, subscribe, type AdapterView, type ExecutionView, type SimResource } from '../lib/api';
import type { McpLogEntry } from '../lib/agent';
import { planFromRequest } from '../lib/planner';
import { useRole } from '../lib/auth';
import { RewindTheater } from '../components/RewindTheater';
import { fmtTime } from '../lib/format';
import { CAPABILITY, EXECUTION_STATUS, POLICY_DECISION, RECOVERY_OUTCOME } from '../lib/strings';
import { Badge, Button, cx, Dialog, EmptyState, ErrorState, Json, LabeledBadge, PageHeader, Section, useAsync, useToast } from '../components/ui';

const DEFAULT_REQUEST = 'Prepare the house for the weekend. Switch the thermostat to away mode, update the household task list, and activate the security routine.';

export function DemoPage() {
  const toast = useToast();
  const { can } = useRole();
  const readOnly = !can('member');
  const [request, setRequest] = useState(DEFAULT_REQUEST);
  const [inject, setInject] = useState(true);
  const [paced, setPaced] = useState(true);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<McpLogEntry[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [view, setView] = useState<ExecutionView | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const plan = useMemo(() => planFromRequest(request), [request]);
  const adapters = useAsync(() => api.adapters(), []);
  const state = useAsync(() => api.demoState(), []);

  const opIndex = useMemo(() => {
    const m = new Map<string, AdapterView['operations'][number]>();
    adapters.data?.adapters.forEach((a) => a.operations.forEach((o) => m.set(o.key, o)));
    return m;
  }, [adapters.data]);

  const refreshExecution = useCallback(async (id: string) => {
    try {
      setView(await api.execution(id));
    } catch {
      /* transient; next event retries */
    }
  }, []);

  // Live updates: engine events refresh home state and the current execution.
  useEffect(
    () =>
      subscribe('/events', (e) => {
        void state.reload({ quiet: true });
        if (e.executionId === executionId) void refreshExecution(e.executionId);
      }),
    [executionId, refreshExecution, state.reload],
  );

  async function run() {
    setRunning(true);
    setLog([]);
    setView(null);
    setExecutionId(null);
    setRunError(null);
    try {
      await api.clearFaults();
      if (inject) await api.armFault('security.activate_routine', 'error');
      await state.reload({ quiet: true });
      // The MCP client SDK is loaded on demand to keep the console's initial bundle small.
      const { runAgent } = await import('../lib/agent');
      const { executionId: id } = await runAgent({
        request,
        plan: plan.map(({ because: _b, ...s }) => ({ ...s, because: '' })),
        pacingMs: paced ? 650 : 0,
        onLog: (e) => setLog((xs) => [...xs, e]),
        onExecution: (eid) => setExecutionId(eid),
      });
      await refreshExecution(id);
      await state.reload({ quiet: true });
    } catch (error) {
      setRunError(error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Agent demo"
        description="A simulated assistant receives a household request and acts only through REWIND's MCP tools. Faults are injected deterministically, so every run is reproducible."
        actions={
          <Button icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => setResetOpen(true)} disabled={running || readOnly}>
            Reset demo
          </Button>
        }
      />

      <div role="note" className="mb-6 flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-xs text-fg-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden />
        <p>
          <strong className="font-semibold text-fg">Browser simulation.</strong> This is not a live Alexa+ integration and controls no real device. The "voice" request is typed text,
          the planner is a deterministic keyword matcher (no LLM), and the home is synthetic data in the local database. The MCP connection and every tool call are real.
        </p>
      </div>

      <div className="mb-6">
        <RewindTheater view={view} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="space-y-6">
          <Section title={<span className="flex items-center gap-2"><Mic className="size-4 text-fg-3" aria-hidden /> Request</span>}>
            <div className="space-y-4 p-4">
              <label className="block">
                <span className="sr-only">Request to the assistant</span>
                <textarea
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  rows={3}
                  maxLength={500}
                  disabled={running}
                  className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent"
                />
              </label>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} disabled={running} className="size-4 accent-[var(--accent)]" />
                  Inject failure: security hub rejects activation
                </label>
                <label className="flex items-center gap-2 text-fg-2">
                  <input type="checkbox" checked={paced} onChange={(e) => setPaced(e.target.checked)} disabled={running} className="size-4 accent-[var(--accent)]" />
                  Presentation pace
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={run} loading={running} disabled={!plan.length || readOnly} icon={<PlayCircle className="size-4" aria-hidden />}>
                  {running ? 'Agent running…' : 'Run agent via MCP'}
                </Button>
                {!plan.length && <span className="text-xs text-warn">The planner recognised no supported intent in this request.</span>}
                {readOnly && <span className="text-xs text-fg-3">Viewers can watch but not run the agent. Ask an admin for the member role.</span>}
              </div>
            </div>
          </Section>

          <Section title="Proposed plan" description="Produced by the deterministic planner. Policy decisions and recovery capabilities come from the server registry.">
            {plan.length ? (
              <ol className="divide-y divide-border">
                {plan.map((s, i) => {
                  const op = opIndex.get(`${s.adapter_id}:${s.operation}`);
                  const live = view?.actions.find((a) => a.operation === s.operation);
                  return (
                    <li key={s.operation} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs font-semibold text-fg-2 tabular">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{op?.title ?? s.operation}</p>
                        <p className="font-mono text-xs text-fg-3">
                          {s.adapter_id}:{s.operation} {JSON.stringify(s.input)}
                        </p>
                        <p className="text-xs text-fg-3">Because the request {s.because}.</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {op && <LabeledBadge map={POLICY_DECISION} value={op.policy.decision} />}
                        {op && <LabeledBadge map={CAPABILITY} value={op.recovery.capability} />}
                        {live && <LabeledBadge map={RECOVERY_OUTCOME} value={live.recoveryOutcome} />}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState title="No plan">Try mentioning the thermostat, the task list, or the security routine.</EmptyState>
            )}
          </Section>

          <Section title={<span className="flex items-center gap-2"><Terminal className="size-4 text-fg-3" aria-hidden /> MCP traffic</span>} description="Every request the browser client sent to /mcp, with the structured result it received.">
            {log.length ? (
              <ol className="max-h-[28rem] divide-y divide-border overflow-auto" aria-live="polite">
                {log.map((e) => (
                  <McpRow key={e.id} e={e} />
                ))}
              </ol>
            ) : (
              <EmptyState icon={<AgentMark className="size-6" aria-hidden />} title="No traffic yet">
                Run the agent to see the initialize handshake, tool discovery and each tool call.
              </EmptyState>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Outcome view={view} running={running} error={runError} executionId={executionId} />
          <HomeState resources={state.data?.resources} faults={state.data?.faults ?? []} error={state.error} />
        </div>
      </div>

      <ScenarioLibrary
        onRan={(v) => {
          setExecutionId(v.execution.id);
          setView(v);
          void state.reload({ quiet: true });
          toast.push({ tone: EXECUTION_STATUS[v.execution.status]?.tone ?? 'neutral', title: `Scenario finished: ${EXECUTION_STATUS[v.execution.status]?.label ?? v.execution.status}`, body: v.execution.taskDescription });
        }}
      />

      <ResetDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onDone={() => {
          setLog([]);
          setView(null);
          setExecutionId(null);
          void state.reload();
        }}
      />
    </>
  );
}

function McpRow({ e }: { e: McpLogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-2/60">
        <span className="w-24 shrink-0 font-mono text-[11px] text-fg-3 tabular">{fmtTime(e.at)}</span>
        <span className="font-mono text-xs text-fg-2">{e.method}</span>
        {e.tool && <span className="truncate font-mono text-xs font-medium">{e.tool}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {e.isError ? <Badge tone="bad">isError</Badge> : <Badge tone="ok" dot={false}>ok</Badge>}
          <span className="w-12 text-right font-mono text-[11px] text-fg-3 tabular">{e.ms} ms</span>
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-2 px-4 pb-3 md:grid-cols-2">
          {e.args !== undefined && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-fg-3">arguments</p>
              <Json value={e.args} />
            </div>
          )}
          <div className={e.args === undefined ? 'md:col-span-2' : ''}>
            <p className="mb-1 text-[11px] font-medium text-fg-3">result</p>
            <Json value={e.result} />
          </div>
        </div>
      )}
    </li>
  );
}

function Outcome({ view, running, error, executionId }: { view: ExecutionView | null; running: boolean; error: unknown; executionId: string | null }) {
  if (error) return <ErrorState error={error} />;
  if (!view) {
    return (
      <Section title="Outcome">
        <EmptyState title={running ? 'Waiting for the first recorded step…' : 'Not run yet'}>
          {running ? 'The execution appears here as soon as the agent creates it.' : 'Results are read back from the server after the run.'}
        </EmptyState>
      </Section>
    );
  }
  const e = view.execution;
  const st = EXECUTION_STATUS[e.status];
  return (
    <Section
      title="Outcome"
      actions={
        executionId && (
          <Link to={`/app/executions/${executionId}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            Open inspector <ArrowRight className="size-3" aria-hidden />
          </Link>
        )
      }
    >
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <LabeledBadge map={EXECUTION_STATUS} value={e.status} pulseWhen={['running', 'recovering']} />
          <span className="text-xs text-fg-3">{st?.help}</span>
        </div>
        {e.failureReason && <p className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">{e.failureReason}</p>}
        <ul className="space-y-2">
          {view.actions.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 w-4 text-xs text-fg-3 tabular">{a.sequence}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a.operationTitle}</p>
                <p className="text-xs text-fg-2">{a.recoveryOutcomeReason}</p>
              </div>
              <LabeledBadge map={RECOVERY_OUTCOME} value={a.recoveryOutcome} />
            </li>
          ))}
        </ul>
        {view.summary.unresolved.length > 0 && e.status !== 'running' && (
          <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
            {view.summary.unresolved.length} effect{view.summary.unresolved.length > 1 ? 's' : ''} not restored. See the inspector for details.
          </p>
        )}
      </div>
    </Section>
  );
}

function HomeState({ resources, faults, error }: { resources?: SimResource[]; faults: { operation: string; mode: string }[]; error: unknown }) {
  const prev = useRef(new Map<string, number>());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!resources) return;
    const changed = new Set<string>();
    for (const r of resources) {
      const k = `${r.type}/${r.id}`;
      const v = prev.current.get(k);
      if (v !== undefined && v !== r.state.version) changed.add(k);
      prev.current.set(k, r.state.version);
    }
    if (changed.size) {
      setFlash(changed);
      const t = setTimeout(() => setFlash(new Set()), 1200);
      return () => clearTimeout(t);
    }
  }, [resources]);
  const get = (type: string) => resources?.find((r) => r.type === type);
  const th = get('thermostat');
  const tasks = get('tasks');
  const sec = get('security');
  const outbox = get('notifications');
  const cell = (k: string, title: string, version: number | undefined, body: React.ReactNode) => (
    <div className={cx('rounded-md border px-3 py-2.5 transition-colors duration-700', flash.has(k) ? 'border-accent bg-accent-soft' : 'border-border')}>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-fg-2">{title}</p>
        <span className="font-mono text-[10px] text-fg-3">v{version ?? '—'}</span>
      </div>
      {body}
    </div>
  );
  return (
    <Section
      title={<span className="flex items-center gap-2"><Home className="size-4 text-fg-3" aria-hidden /> Synthetic home</span>}
      description="Read live from the adapter's persisted store. Highlights mark a version change."
    >
      {error ? (
        <div className="p-4">
          <ErrorState error={error} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-4">
          {cell(
            'thermostat/main',
            'Thermostat',
            th?.state.version,
            <p className="text-sm">
              <span className="font-medium capitalize">{th?.state.data.mode ?? '—'}</span> · {th?.state.data.targetC ?? '—'} °C
            </p>,
          )}
          {cell(
            'tasks/household',
            'Household tasks',
            tasks?.state.version,
            <ul className="space-y-0.5 text-sm">
              {(tasks?.state.data.items as { id: string; title: string; done: boolean }[] | undefined)?.map((t) => (
                <li key={t.id} className={cx('flex gap-2', t.done && 'text-fg-3 line-through')}>
                  <span className="font-mono text-xs text-fg-3">{t.id}</span>
                  {t.title}
                </li>
              ))}
            </ul>,
          )}
          {cell('security/routine', 'Security routine', sec?.state.version, <p className="text-sm"><span className="font-medium">{sec?.state.data.routine}</span> · {sec?.state.data.state}</p>)}
          {cell(
            'notifications/outbox',
            'Household messages sent',
            outbox?.state.version,
            <p className="text-sm">{(outbox?.state.data.sent as unknown[] | undefined)?.length ?? 0} sent {(outbox?.state.data.sent as unknown[] | undefined)?.length ? '(cannot be unsent)' : ''}</p>,
          )}
          <div className="text-xs text-fg-3">
            Armed faults:{' '}
            {faults.length ? faults.map((f) => <code key={`${f.operation}${f.mode}`} className="mr-1 rounded bg-surface-2 px-1">{`${f.operation} → ${f.mode}`}</code>) : 'none'}
          </div>
        </div>
      )}
    </Section>
  );
}

function ScenarioLibrary({ onRan }: { onRan: (v: ExecutionView) => void }) {
  const canRun = useRole().can('member');
  const { data, error } = useAsync(() => api.scenarios(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Section className="mt-6" title="Reproducible failure scenarios" description="Each runs a fixed plan with fixed faults through the same engine via the HTTP API. Use them to see every recovery outcome REWIND can report.">
      {error ? (
        <div className="p-4">
          <ErrorState error={error} />
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
          {data?.scenarios.map((s) => (
            <li key={s.id} className="flex flex-col bg-surface p-4">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="mt-1 flex-1 text-xs leading-relaxed text-fg-2">{s.summary}</p>
              <p className="mt-2 text-[11px] text-fg-3">
                Faults: {s.faults.length ? s.faults.map((f) => `${f.operation} → ${f.mode}`).join(', ') : 'none'}
              </p>
              <p className="mt-0.5 text-[11px] text-fg-3">Expected: {s.expected}</p>
              <div className="mt-3">
                <Button
                  size="sm"
                  loading={busy === s.id}
                  disabled={busy !== null || !canRun}
                  onClick={async () => {
                    setBusy(s.id);
                    try {
                      onRan(await api.runScenario(s.id, true));
                    } catch (e) {
                      toast.push({ tone: 'bad', title: 'Scenario could not run', body: e instanceof Error ? e.message : String(e) });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Run scenario
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ResetDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [clearHistory, setClearHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onClose={() => {
        setErr(null);
        onClose();
      }}
      title="Reset the demo environment?"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await api.reset(clearHistory);
                toast.push({ tone: 'ok', title: 'Demo reset', body: clearHistory ? `Home restored to seed. ${r.executionsDeleted} executions deleted.` : 'Home restored to its seed state. History kept.' });
                onDone();
                onClose();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Reset
          </Button>
        </>
      }
    >
      <p>The synthetic home returns to its deterministic seed state and all armed faults are cleared. This does not affect any real device.</p>
      <label className="mt-4 flex items-start gap-2 text-fg">
        <input type="checkbox" checked={clearHistory} onChange={(e) => setClearHistory(e.target.checked)} className="mt-0.5 size-4 accent-[var(--bad)]" />
        <span>
          Also permanently delete all execution history and audit events in this workspace
          <span className="block text-xs text-fg-3">The deletion itself is recorded as an audit event.</span>
        </span>
      </label>
      {err && <p className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">{err}</p>}
    </Dialog>
  );
}
