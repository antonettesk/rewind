import { AgentMark, ArrowRight, CircleAlert, Home, Mic, Pause, PlayCircle, RotateCcw, Terminal } from '../components/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, subscribe, type AdapterView, type ExecutionView, type NovaPlan, type SimResource } from '../lib/api';
import type { McpLogEntry } from '../lib/agent';
import { planFromRequest, SAMPLE_PROMPTS, type PlannedStep } from '../lib/planner';
import { canListen, confirmation, hush, listen, say } from '../lib/voice';
import { VoiceOrb, type VoiceState } from '../components/VoiceOrb';
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
  const [params, setParams] = useSearchParams();
  const [request, setRequest] = useState(() => params.get('request')?.slice(0, 500) || DEFAULT_REQUEST);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [speakReplies, setSpeakReplies] = useState(() => params.get('voice') === '1');
  const stopListening = useRef<(() => void) | null>(null);
  // A run paused at the approval gate: the agent resumes from the next step once a person approves.
  const paused = useRef<{ executionId: string; steps: PlannedStep[]; at: number; talk: boolean } | null>(null);
  useEffect(() => () => hush(), []);
  const [inject, setInject] = useState(true);
  const [paced, setPaced] = useState(true);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<McpLogEntry[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [view, setView] = useState<ExecutionView | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const aws = useAsync(() => api.aws(), []);
  const novaReady = Boolean(aws.data?.nova.enabled);
  const [planner, setPlanner] = useState<'nova' | 'rules'>('rules');
  useEffect(() => {
    if (novaReady) setPlanner('nova');
  }, [novaReady]);
  // A Nova plan belongs to the exact request text it was made for.
  const [nova, setNova] = useState<{ request: string; plan: NovaPlan } | null>(null);
  const [planning, setPlanning] = useState(false);
  const rulesPlan = useMemo(() => planFromRequest(request), [request]);
  const novaPlan = nova && nova.request === request ? nova.plan : null;
  const plan: PlannedStep[] = planner === 'nova' ? (novaPlan?.steps ?? []) : rulesPlan;
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

  async function planWithNova(text = request): Promise<PlannedStep[] | null> {
    setPlanning(true);
    try {
      const p = await api.novaPlan(text);
      setNova({ request: text, plan: p });
      return p.steps;
    } catch (error) {
      toast.push({ tone: 'bad', title: 'Amazon Nova could not plan this request', body: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setPlanning(false);
    }
  }

  async function run(text = request, opts: { spoken?: boolean } = {}) {
    const talk = opts.spoken || speakReplies;
    let steps: PlannedStep[] = text === request ? plan : planFromRequest(text);
    if (planner === 'nova' && !(novaPlan && text === request)) {
      if (talk) setVoice('thinking');
      const fresh = await planWithNova(text);
      if (!fresh) return setVoice('idle');
      steps = fresh;
    }
    if (!steps.length) {
      toast.push({ tone: 'warn', title: 'Nothing to run', body: 'No registered operation fits this request. Try the thermostat, the task list, a message, or the security routine.' });
      if (talk) {
        setVoice('speaking');
        await say(confirmation([]));
      }
      return setVoice('idle');
    }
    if (talk) {
      setVoice('speaking');
      await say(confirmation(steps));
      setVoice('thinking');
    }
    setRunning(true);
    setLog([]);
    setView(null);
    setExecutionId(null);
    setRunError(null);
    try {
      await api.clearFaults();
      // Fail the last step, so every earlier step has something to rewind.
      const target = steps.at(-1)!.operation;
      if (inject && target !== 'security.disarm') await api.armFault(target, 'error');
      await state.reload({ quiet: true });
      // The MCP client SDK is loaded on demand to keep the console's initial bundle small.
      const { runAgent } = await import('../lib/agent');
      paused.current = null;
      const { executionId: id, pausedAt } = await runAgent({
        request: text,
        plan: steps.map(({ because: _b, ...s }) => ({ ...s, because: '' })),
        pacingMs: paced ? 650 : 0,
        onLog: (e) => setLog((xs) => [...xs, e]),
        onExecution: (eid) => setExecutionId(eid),
      });
      await refreshExecution(id);
      await state.reload({ quiet: true });
      if (pausedAt !== null) paused.current = { executionId: id, steps, at: pausedAt, talk };
      await speakOutcome(id, talk);
    } catch (error) {
      setRunError(error);
    } finally {
      setRunning(false);
      setVoice('idle');
    }
  }

  async function speakOutcome(id: string, talk: boolean) {
    if (!talk) return;
    setVoice('speaking');
    const { text: summary } = await api.executionSummary(id);
    await say(summary, { audioUrl: aws.data?.polly.enabled ? api.voiceUrl(id) : undefined });
    setVoice('idle');
  }

  /** After a person approves, the agent sends the remaining steps over MCP, like a real agent waiting on a human. */
  async function afterDecision(v: ExecutionView) {
    setView(v);
    void state.reload({ quiet: true });
    const p = paused.current;
    paused.current = null;
    if (!p || v.execution.id !== p.executionId || v.execution.status !== 'running') return speakOutcome(v.execution.id, p?.talk ?? speakReplies);
    setRunning(true);
    try {
      const { runAgent } = await import('../lib/agent');
      const r = await runAgent({
        request,
        plan: p.steps.map(({ because: _b, ...s }) => ({ ...s, because: '' })),
        pacingMs: paced ? 650 : 0,
        onLog: (e) => setLog((xs) => [...xs, e]),
        onExecution: () => undefined,
        resume: { executionId: p.executionId, from: p.at + 1 },
        idBase: log.length + 1000,
      });
      await refreshExecution(p.executionId);
      await state.reload({ quiet: true });
      if (r.pausedAt !== null) paused.current = { ...p, at: r.pausedAt };
      await speakOutcome(p.executionId, p.talk);
    } catch (error) {
      setRunError(error);
    } finally {
      setRunning(false);
      setVoice('idle');
    }
  }

  function toggleListening() {
    if (voice === 'listening') return stopListening.current?.();
    hush();
    setVoice('listening');
    let heard = '';
    stopListening.current = listen({
      onInterim: (t) => setRequest(t),
      onFinal: (t) => {
        heard = t;
        setRequest(t);
      },
      onError: (m) => {
        toast.push({ tone: 'warn', title: 'Voice input', body: m });
        setVoice('error');
        setTimeout(() => setVoice('idle'), 1500);
      },
      onEnd: () => {
        stopListening.current = null;
        if (heard) {
          setSpeakReplies(true);
          void run(heard, { spoken: true });
        } else setVoice((v) => (v === 'listening' ? 'idle' : v));
      },
    });
  }

  // Arriving from the landing page with ?request=…&autorun=1 runs it once.
  const autoran = useRef(false);
  useEffect(() => {
    if (autoran.current || params.get('autorun') !== '1' || readOnly || !adapters.data || aws.loading) return;
    autoran.current = true;
    const next = new URLSearchParams(params);
    next.delete('autorun');
    next.delete('voice');
    setParams(next, { replace: true });
    void run(request);
  }, [adapters.data, aws.loading]);

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
          <strong className="font-semibold text-fg">Browser simulation.</strong> This is not a live Alexa+ integration and controls no real device; the home is synthetic data.
          Speak or type a request. Voice uses your browser's built-in speech recognition and voices. {planner === 'nova'
            ? 'Amazon Nova on Bedrock proposes the steps; REWIND validates each one against the operation schema and decides ordering itself. Execution, recovery and verification never involve the model.'
            : 'The planner is a deterministic keyword matcher (no LLM).'}{' '}
          The MCP connection and every tool call are real.
        </p>
      </div>

      <div className="mb-6">
        <RewindTheater view={view} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="space-y-6">
          <Section title={<span className="flex items-center gap-2"><Mic className="size-4 text-fg-3" aria-hidden /> Request</span>}>
            <div className="space-y-4 p-4">
              <div className="flex items-start gap-4">
                {canListen() && <VoiceOrb state={voice} onClick={toggleListening} disabled={running || planning || readOnly} />}
                <label className="block min-w-0 flex-1">
                  <span className="sr-only">Request to the assistant</span>
                  <textarea
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) void run();
                    }}
                    rows={3}
                    maxLength={500}
                    disabled={running || voice === 'listening'}
                    placeholder="Ask the house to do something, e.g. “set the heat to 18 and lock up”"
                    className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5" aria-label="Sample requests">
                <span className="mr-1 text-xs text-fg-3">Try:</span>
                {SAMPLE_PROMPTS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    disabled={running}
                    onClick={() => setRequest(p.text)}
                    className={cx('rounded-full border px-2.5 py-1 text-xs transition', request === p.text ? 'border-accent bg-accent-soft text-fg' : 'border-border text-fg-2 hover:border-border-strong hover:text-fg')}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div role="radiogroup" aria-label="Planner" className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5 text-xs">
                {([
                  ['nova', 'Amazon Nova', novaReady],
                  ['rules', 'Deterministic rules', true],
                ] as const).map(([id, label, ok]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={planner === id}
                    disabled={!ok || running}
                    title={!ok ? 'Set REWIND_AWS_REGION and AWS credentials on the server to enable Amazon Nova.' : undefined}
                    onClick={() => setPlanner(id)}
                    className={cx('rounded-md px-3 py-1.5 font-medium transition', planner === id ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg disabled:opacity-50')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} disabled={running} className="size-4 accent-[var(--accent)]" />
                  Inject a failure on the last step{plan.length ? `: ${opIndex.get(`${plan.at(-1)!.adapter_id}:${plan.at(-1)!.operation}`)?.title ?? plan.at(-1)!.operation}` : ''}
                </label>
                <label className="flex items-center gap-2 text-fg-2">
                  <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} disabled={running} className="size-4 accent-[var(--accent)]" />
                  Speak replies
                </label>
                <label className="flex items-center gap-2 text-fg-2">
                  <input type="checkbox" checked={paced} onChange={(e) => setPaced(e.target.checked)} disabled={running} className="size-4 accent-[var(--accent)]" />
                  Presentation pace
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={() => void run()} loading={running || planning} disabled={(planner === 'rules' && !plan.length) || readOnly} icon={<PlayCircle className="size-4" aria-hidden />}>
                  {planning ? 'Amazon Nova is planning…' : running ? 'Agent running…' : planner === 'nova' && !novaPlan ? 'Plan with Nova and run' : 'Run agent via MCP'}
                </Button>
                {planner === 'nova' && !novaPlan && (
                  <Button onClick={() => void planWithNova()} disabled={planning || running || readOnly}>
                    Preview plan
                  </Button>
                )}
                {planner === 'rules' && !plan.length && <span className="text-xs text-warn">The planner recognised no supported intent in this request.</span>}
                {readOnly && <span className="text-xs text-fg-3">Viewers can watch but not run the agent. Ask an admin for the member role.</span>}
              </div>
            </div>
          </Section>

          <Section
            title="Proposed plan"
            description={
              planner === 'nova'
                ? novaPlan
                  ? `Proposed by ${novaPlan.model} in ${novaPlan.latencyMs} ms${novaPlan.usage ? ` (${novaPlan.usage.inputTokens + novaPlan.usage.outputTokens} tokens)` : ''}, then validated by REWIND. Policy and recovery capabilities come from the server registry.`
                  : 'Amazon Nova proposes steps when you run or preview. REWIND rejects anything outside the registry or its input schemas.'
                : 'Produced by the deterministic planner. Policy decisions and recovery capabilities come from the server registry.'
            }
          >
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
                        <p className="text-xs text-fg-3">{planner === 'nova' ? <>Nova&apos;s reason: &ldquo;{s.because}&rdquo;</> : <>Because the request {s.because}.</>}</p>
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
            ) : planner === 'nova' && !novaPlan ? (
              <EmptyState title="Not planned yet">Press Preview plan, or run, and Amazon Nova will propose steps for this request.</EmptyState>
            ) : (
              <EmptyState title="No plan">Try mentioning the thermostat, the task list, or the security routine.</EmptyState>
            )}
            {planner === 'nova' && novaPlan && novaPlan.rejected.length > 0 && (
              <div className="border-t border-border px-4 py-3 text-xs text-fg-2">
                <p className="font-medium text-warn">REWIND refused {novaPlan.rejected.length} proposal{novaPlan.rejected.length > 1 ? 's' : ''} from the model:</p>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {novaPlan.rejected.map((r, i) => (
                    <li key={i}>
                      {r.operation}: {r.reason}
                    </li>
                  ))}
                </ul>
              </div>
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
          <Outcome
            view={view}
            running={running}
            error={runError}
            executionId={executionId}
            voice={Boolean(aws.data?.polly.enabled)}
            canDecide={can('admin')}
            onDecided={(v) => void afterDecision(v)}
          />
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

function Outcome({
  view,
  running,
  error,
  executionId,
  voice,
  canDecide,
  onDecided,
}: {
  view: ExecutionView | null;
  running: boolean;
  error: unknown;
  executionId: string | null;
  voice: boolean;
  canDecide: boolean;
  onDecided: (v: ExecutionView) => void;
}) {
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
        {e.status === 'awaiting_approval' && <ApprovalPrompt view={view} canDecide={canDecide} onDecided={onDecided} />}
        {voice && !running && !['pending', 'running', 'recovering', 'awaiting_approval'].includes(e.status) && <VoiceReport executionId={e.id} status={e.status} />}
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

function VoiceReport({ executionId, status }: { executionId: string; status: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  // A new status means a new summary; drop any audio for the old one.
  useEffect(() => setState('idle'), [executionId, status]);
  const play = () => {
    const el = ref.current!;
    if (state === 'playing') {
      el.pause();
      el.currentTime = 0;
      setState('idle');
      return;
    }
    setState('loading');
    el.src = `${api.voiceUrl(executionId)}?s=${encodeURIComponent(status)}`;
    el.play().catch(() => setState('error'));
  };
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-2/60 px-3 py-2">
      <button
        type="button"
        onClick={play}
        className="inline-flex items-center gap-2 rounded-md bg-fg px-3 py-1.5 text-xs font-semibold text-bg transition hover:opacity-90"
        aria-label={state === 'playing' ? 'Stop voice report' : 'Listen to the voice report'}
      >
        {state === 'playing' ? <Pause className="size-3.5" aria-hidden /> : <Mic className="size-3.5" aria-hidden />}
        {state === 'loading' ? 'Preparing…' : state === 'playing' ? 'Stop' : 'Listen'}
      </button>
      <p className="text-xs text-fg-2">{state === 'error' ? 'The voice report could not be played.' : 'REWIND\'s own outcome, read aloud by Amazon Polly. Written from recorded state, not by a model.'}</p>
      <audio ref={ref} onPlaying={() => setState('playing')} onEnded={() => setState('idle')} onError={() => setState('error')} preload="none" className="hidden" />
    </div>
  );
}

/** The human approval gate, inline: the visitor decides here instead of leaving for the inspector. */
function ApprovalPrompt({ view, canDecide, onDecided }: { view: ExecutionView; canDecide: boolean; onDecided: (v: ExecutionView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const action = view.actions.find((a) => a.status === 'awaiting_approval');
  if (!action) return null;
  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    try {
      onDecided(kind === 'approve' ? await api.approve(view.execution.id, action.id) : await api.reject(view.execution.id, action.id, 'Rejected in the agent demo.'));
    } catch (error) {
      toast.push({ tone: 'bad', title: kind === 'approve' ? 'Could not approve' : 'Could not reject', body: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-3 text-sm" role="group" aria-label="Approval needed">
      <p className="font-medium text-fg">
        Step {action.sequence}, {action.operationTitle}, needs a person to approve it.
      </p>
      <p className="mt-1 text-xs text-fg-2">
        Policy requires approval because this effect {action.capability === 'irreversible' ? 'cannot be undone once it happens' : 'is sensitive'}. Agents can never approve their own actions.
      </p>
      {canDecide ? (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => void decide('approve')} loading={busy === 'approve'} disabled={busy !== null}>
            Approve and continue
          </Button>
          <Button onClick={() => void decide('reject')} loading={busy === 'reject'} disabled={busy !== null}>
            Reject
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-fg-3">Ask an admin to approve or reject it.</p>
      )}
    </div>
  );
}
