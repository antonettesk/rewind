import { ArrowRight, PlayCircle, Plug, ShieldCheck } from '../components/icons';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { api, subscribe } from '../lib/api';
import { GettingStarted } from '../components/GettingStarted';
import { useAuth } from '../lib/auth';
import { fmtNumber, fmtRelative } from '../lib/format';
import { ATTEMPT_STATUS, EXECUTION_STATUS } from '../lib/strings';
import { Badge, Button, EmptyState, ErrorState, LabeledBadge, LoadingRows, PageHeader, Section, Stat, useAsync } from '../components/ui';

export function OverviewPage() {
  const { data, error, loading, reload } = useAsync(() => api.overview(), []);
  const { me } = useAuth();
  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${me && me.user.kind !== 'guest' ? `, ${me.user.name.split(/\s+/)[0]}` : ''}`;
  useEffect(() => subscribe('/events', () => void reload({ quiet: true })), [reload]);

  const s = data?.stats;
  const isDemo = data?.environment === 'local-demo';
  const empty = s && s.total === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${greeting}. Here's what your agents did, what failed, and what Rewind could prove it restored.`}
        actions={
          <Link to="/app/demo">
            <Button variant="primary" icon={<PlayCircle className="size-4" aria-hidden />}>
              Run demo scenario
            </Button>
          </Link>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => void reload()} /> : null}
      <GettingStarted />

      {empty && <FirstRun />}

      {s && !empty && (
        <Section className="mb-6" title={<span className="flex items-center gap-2">Workspace activity {isDemo && <Badge tone="accent" dot={false}>Demo data</Badge>}</span>} description="Counts are computed from stored executions in this workspace.">
          <div className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
            <Stat label="Executions" value={fmtNumber(s.total)} />
            <Stat label="Succeeded" value={fmtNumber(s.byStatus.succeeded ?? 0)} tone="ok" />
            <Stat label="Failed → recovered & verified" value={fmtNumber(s.failuresRecoverable)} tone="ok" hint="Every effect restored and read back" />
            <Stat label="Failed → not fully recoverable" value={fmtNumber(s.failuresNonRecoverable)} tone={s.failuresNonRecoverable ? 'warn' : undefined} hint="Partial or failed recovery" />
            <Stat label="Recovery attempts verified" value={`${fmtNumber(s.recoveryVerified)} / ${fmtNumber(s.recoveryAttempts)}`} hint="Compensations confirmed by read-back" />
          </div>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <Section
          title="Recent executions"
          actions={
            <Link to="/app/executions" className="text-xs font-medium text-accent hover:underline">
              View all
            </Link>
          }
        >
          {loading && !data ? (
            <LoadingRows />
          ) : data?.recentExecutions.length ? (
            <ul className="divide-y divide-border">
              {data.recentExecutions.map((e) => (
                <li key={e.id}>
                  <Link to={`/app/executions/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{e.taskDescription}</p>
                      <p className="mt-0.5 font-mono text-xs text-fg-3">
                        {e.id} · {fmtRelative(e.createdAt)}
                      </p>
                    </div>
                    <LabeledBadge map={EXECUTION_STATUS} value={e.status} pulseWhen={['running', 'recovering']} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No executions yet">Run the demo or connect an MCP client to record your first execution.</EmptyState>
          )}
        </Section>

        <div className="space-y-6">
          <Section title="Recent recovery attempts">
            {loading && !data ? (
              <LoadingRows rows={3} />
            ) : data?.recentRecoveryAttempts.length ? (
              <ul className="divide-y divide-border">
                {data.recentRecoveryAttempts.map((a) => (
                  <li key={a.id}>
                    <Link to={`/app/executions/${a.executionId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs">
                          {a.adapterId}:{a.operation}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-3">
                          Attempt {a.attemptNumber} · {fmtRelative(a.startedAt)}
                        </p>
                      </div>
                      <LabeledBadge map={ATTEMPT_STATUS} value={a.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No recovery attempts">Attempts appear here when a step fails after earlier steps changed something.</EmptyState>
            )}
          </Section>

          <Section title="Next steps">
            <ul className="divide-y divide-border text-sm">
              {[
                { to: '/app/settings/connect', icon: Plug, title: 'Connect an MCP client', body: 'Create an API key and point any Streamable HTTP client at /mcp.' },
                { to: '/app/executions', icon: ArrowRight, title: 'Investigate executions', body: 'Search failures and inspect their full trace.' },
                { to: '/app/policies', icon: ShieldCheck, title: 'Review policies', body: 'Control what may run, what needs approval, and recovery limits.' },
              ].map((n) => (
                <li key={n.to}>
                  <Link to={n.to} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2/60">
                    <n.icon className="mt-0.5 size-4 text-fg-3" aria-hidden />
                    <div>
                      <p className="font-medium">{n.title}</p>
                      <p className="text-xs text-fg-2">{n.body}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

function FirstRun() {
  return (
    <Section className="mb-6">
      <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-3">Why Rewind exists</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">An agent changed two things, then the third step failed.</h2>
          <p className="mt-2 text-sm leading-relaxed text-fg-2">
            The thermostat is in away mode and the task list was edited, but the security routine never activated. A model saying "I'll undo that" proves nothing. Rewind
            captures each resource before it changes, runs registered compensations in reverse order, and reads every resource back to verify it. When an effect cannot
            be reversed, it says so.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/app/demo">
              <Button variant="primary" icon={<PlayCircle className="size-4" aria-hidden />}>
                Run the demo (no keys needed)
              </Button>
            </Link>
            <Link to="/app/settings">
              <Button>Connect an MCP client</Button>
            </Link>
          </div>
        </div>
        <ol className="space-y-3 border-l border-border pl-5 text-sm">
          {[
            ['Recorded', 'Every step, policy decision and state snapshot is persisted before and after it happens.'],
            ['Contained', 'The first failure halts forward progress. Nothing new runs.'],
            ['Compensated', 'Only steps with a registered compensation are reversed, newest first.'],
            ['Verified', 'Restoration counts only when reading the resource back matches the captured original.'],
          ].map(([t, b], i) => (
            <li key={t} className="relative">
              <span className="absolute -left-[27px] top-0.5 flex size-4 items-center justify-center rounded-full border border-border-strong bg-surface text-[10px] font-semibold text-fg-2">{i + 1}</span>
              <p className="font-medium">{t}</p>
              <p className="text-xs text-fg-2">{b}</p>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
