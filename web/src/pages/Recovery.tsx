import { LifeBuoy, RotateCcw } from '../components/icons';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, subscribe, type RecoveryItem } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { ATTEMPT_STATUS, EXECUTION_STATUS, RECOVERY_OUTCOME } from '../lib/strings';
import { Button, Dialog, EmptyState, ErrorState, LabeledBadge, LoadingRows, PageHeader, Section, useAsync, useToast } from '../components/ui';

export function RecoveryPage() {
  const { data, error, loading, reload } = useAsync(() => api.recovery(), []);
  useEffect(() => subscribe('/events', (e) => e.eventType === 'recovery.completed' && void reload({ quiet: true })), [reload]);
  const [target, setTarget] = useState<RecoveryItem | null>(null);
  const attention = data?.items.filter((i) => i.summary.unresolved.length > 0 || i.execution.status === 'recovering') ?? [];
  const resolved = data?.items.filter((i) => i.summary.unresolved.length === 0 && i.execution.status !== 'recovering') ?? [];

  return (
    <>
      <PageHeader
        title="Recovery"
        description="Every recovery REWIND attempted, why, and what it could verify. Retry appears only where the registered compensation is safe to repeat and policy allows it."
      />
      {error ? <ErrorState error={error} onRetry={() => void reload()} /> : null}
      <Section title="Needs attention" description="Executions with effects that were not restored and verified." className="mb-6">
        {loading && !data ? (
          <LoadingRows />
        ) : attention.length ? (
          <ul className="divide-y divide-border">
            {attention.map((i) => (
              <RecoveryRow key={i.execution.id} item={i} onRetry={() => setTarget(i)} />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<LifeBuoy className="size-6" aria-hidden />} title="Nothing unresolved">
            Every failed execution was either fully recovered and verified, or had nothing to recover.
          </EmptyState>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Resolved" description="Recovered and verified, or nothing to recover.">
          {resolved.length ? (
            <ul className="divide-y divide-border">
              {resolved.map((i) => (
                <RecoveryRow key={i.execution.id} item={i} compact />
              ))}
            </ul>
          ) : (
            <EmptyState title="No resolved recoveries yet" />
          )}
        </Section>
        <Section title="Attempt log" description="Individual compensation attempts, newest first.">
          {data?.attempts.length ? (
            <ul className="max-h-[32rem] divide-y divide-border overflow-auto">
              {data.attempts.map((a) => (
                <li key={a.id}>
                  <Link to={`/app/executions/${a.executionId}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs">
                        {a.adapterId}:{a.operation}
                      </p>
                      <p className="truncate text-xs text-fg-3">
                        Attempt {a.attemptNumber} · {a.errorCode ?? (a.verification?.restored ? 'read-back matched' : '')} · {fmtRelative(a.startedAt)}
                      </p>
                    </div>
                    <LabeledBadge map={ATTEMPT_STATUS} value={a.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No attempts recorded" />
          )}
        </Section>
      </div>

      <RetryDialog item={target} onClose={() => setTarget(null)} onDone={() => void reload({ quiet: true })} />
    </>
  );
}

function RecoveryRow({ item, onRetry, compact }: { item: RecoveryItem; onRetry?: () => void; compact?: boolean }) {
  const e = item.execution;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <Link to={`/app/executions/${e.id}`} className="block truncate text-sm font-medium hover:text-accent">
            {e.taskDescription}
          </Link>
          <p className="font-mono text-xs text-fg-3">
            {e.id} · {fmtRelative(e.completedAt ?? e.createdAt)} · {item.requests.length} request{item.requests.length === 1 ? '' : 's'}
          </p>
          {e.failureReason && !compact && <p className="mt-1 text-xs text-fg-2">Reason: {e.failureReason}</p>}
        </div>
        <div className="flex items-center gap-2">
          <LabeledBadge map={EXECUTION_STATUS} value={e.status} pulseWhen={['recovering']} />
          {onRetry && item.summary.retry.available && (
            <Button size="sm" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={onRetry} title={item.summary.retry.reason}>
              Retry
            </Button>
          )}
        </div>
      </div>
      {!compact && (
        <>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {item.steps
              .filter((s) => s.recoveryOutcome !== 'not_required' || s.status === 'failed')
              .map((s) => (
                <li key={s.id} className="flex items-center gap-1.5 text-xs">
                  <span className="text-fg-3">#{s.sequence}</span>
                  <span>{s.operationTitle}</span>
                  <LabeledBadge map={RECOVERY_OUTCOME} value={s.recoveryOutcome} />
                </li>
              ))}
          </ul>
          {!item.summary.retry.available && item.summary.unresolved.length > 0 && <p className="mt-1.5 text-xs text-fg-3">Retry unavailable: {item.summary.retry.reason}</p>}
        </>
      )}
    </li>
  );
}

function RetryDialog({ item, onClose, onDone }: { item: RecoveryItem | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Dialog
      open={item !== null}
      onClose={() => {
        setErr(null);
        onClose();
      }}
      title="Retry recovery?"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!item) return;
              setBusy(true);
              setErr(null);
              try {
                const v = await api.recover(item.execution.id, `ui-retry-${Date.now()}`);
                toast.push({ tone: EXECUTION_STATUS[v.execution.status]?.tone ?? 'neutral', title: 'Recovery retry finished', body: `Now ${EXECUTION_STATUS[v.execution.status]?.label}.` });
                onDone();
                onClose();
              } catch (x) {
                setErr(x instanceof Error ? x.message : String(x));
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry recovery
          </Button>
        </>
      }
    >
      <p>{item?.summary.retry.reason}</p>
      <p className="mt-2">Verified steps are not touched again. Each compensation re-checks the resource version first and stops if someone else changed it.</p>
      {err && <p className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">{err}</p>}
    </Dialog>
  );
}
