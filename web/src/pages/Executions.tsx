import { ListTree, Search } from '../components/icons';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, subscribe, type ExecutionListItem } from '../lib/api';
import { fmtDateTime, fmtDuration, fmtRelative } from '../lib/format';
import { EXECUTION_STATUS } from '../lib/strings';
import { Button, cx, EmptyState, ErrorState, LabeledBadge, LoadingRows, PageHeader, Section } from '../components/ui';
import { msBetween } from '../lib/time';

const FILTERS: { label: string; statuses: string[] }[] = [
  { label: 'All', statuses: [] },
  { label: 'Needs attention', statuses: ['partially_recovered', 'recovery_failed', 'failed', 'awaiting_approval'] },
  { label: 'Recovered', statuses: ['recovered'] },
  { label: 'Succeeded', statuses: ['succeeded'] },
  { label: 'In progress', statuses: ['pending', 'running', 'recovering'] },
];

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const filter = Number(params.get('f') ?? 0);
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const [items, setItems] = useState<ExecutionListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .executions({ status: FILTERS[filter]?.statuses, search: q })
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [filter, q, tick]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe('/events', (e) => {
      if (e.eventType !== 'execution.status_changed' && e.eventType !== 'execution.created') return;
      clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), 300);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) setParams((p) => (search ? p.set('q', search) : p.delete('q'), p), { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [search, q, setParams]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.executions({ status: FILTERS[filter]?.statuses, search: q, cursor });
      setItems((xs) => [...(xs ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader title="Executions" description="Every recorded multi-step execution in this workspace, newest first." />
      <Section>
        <div className="flex flex-col gap-3 border-b border-border p-3 md:flex-row md:items-center md:justify-between">
          <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {FILTERS.map((f, i) => (
              <button
                key={f.label}
                role="tab"
                aria-selected={filter === i}
                onClick={() => setParams((p) => (i ? p.set('f', String(i)) : p.delete('f'), p))}
                className={cx('rounded-md px-2.5 py-1 text-xs font-medium', filter === i ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-surface-2')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="relative block md:w-72">
            <span className="sr-only">Search executions</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search task or execution ID"
              className="h-8 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent"
            />
          </label>
        </div>

        {error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={() => setTick((n) => n + 1)} />
          </div>
        ) : !items ? (
          <LoadingRows rows={6} />
        ) : items.length === 0 ? (
          <EmptyState icon={<ListTree className="size-6" aria-hidden />} title={q || filter ? 'No matching executions' : 'No executions yet'} action={!q && !filter && <Link to="/app/demo"><Button variant="primary">Run the demo</Button></Link>}>
            {q || filter ? 'Try a different filter or search term.' : 'Executions are recorded when an agent calls Rewind through MCP or when you run a demo scenario.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-fg-2">
                  <th scope="col" className="px-4 py-2 font-medium">Task</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Steps</th>
                  <th scope="col" className="px-3 py-2 font-medium">Failure point</th>
                  <th scope="col" className="px-3 py-2 font-medium">Duration</th>
                  <th scope="col" className="px-3 py-2 font-medium">Source · env</th>
                  <th scope="col" className="px-4 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-2/60">
                    <td className="max-w-[22rem] px-4 py-2.5">
                      <Link to={`/app/executions/${e.id}`} className="block truncate font-medium hover:text-accent">
                        {e.taskDescription}
                      </Link>
                      <span className="font-mono text-xs text-fg-3">{e.id}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <LabeledBadge map={EXECUTION_STATUS} value={e.status} pulseWhen={['running', 'recovering']} />
                    </td>
                    <td className="px-3 py-2.5 tabular text-fg-2">{e.actionCount}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{e.failurePoint ? `#${e.failurePoint.sequence} ${e.failurePoint.operation.split(':')[1]}` : '—'}</td>
                    <td className="px-3 py-2.5 tabular text-fg-2">{fmtDuration(msBetween(e.startedAt ?? e.createdAt, e.completedAt))}</td>
                    <td className="px-3 py-2.5 text-xs text-fg-2">
                      {e.source}
                      <span className="block text-fg-3">
                        {e.environment} · {e.adapters.join(', ') || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-fg-2" title={fmtDateTime(e.createdAt)}>
                      {fmtRelative(e.createdAt)}
                      <span className="block text-fg-3">{e.completedAt ? `done ${fmtRelative(e.completedAt)}` : 'open'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" onClick={loadMore} loading={loadingMore}>
              Load more
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}
