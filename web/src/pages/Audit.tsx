import { FileLock2, Search } from '../components/icons';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Badge, EmptyState, ErrorState, Json, LoadingRows, PageHeader, Section, useAsync } from '../components/ui';
import { api, type AuditEvent } from '../lib/api';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { EVENT_LABEL, eventTone } from '../lib/strings';

const EXTRA_LABELS: Record<string, string> = {
  'policy.updated': 'Policy changed',
  'api_key.created': 'API key created',
  'api_key.revoked': 'API key revoked',
  'invitation.created': 'Invitation created',
  'member.joined': 'Member joined',
  'member.role_changed': 'Member role changed',
  'member.removed': 'Member removed',
  'webhook.created': 'Webhook added',
  'webhook.deleted': 'Webhook deleted',
  'demo.reset': 'Demo environment reset',
};

const GROUPS: { label: string; match: (t: string) => boolean }[] = [
  { label: 'All', match: () => true },
  { label: 'Admin & access', match: (t) => /^(policy|api_key|invitation|member|webhook|demo)\./.test(t) },
  { label: 'Approvals', match: (t) => t.startsWith('approval.') },
  { label: 'Recovery', match: (t) => /^(recovery|compensation|verification|reconciliation)\./.test(t) },
  { label: 'Failures', match: (t) => /failed|outcome_unknown|conflict|interrupted/.test(t) },
];

export function AuditPage() {
  const { data, error, loading, reload } = useAsync(() => api.audit(200), []);
  const [group, setGroup] = useState(0);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const events = useMemo(
    () =>
      (data?.events ?? []).filter(
        (e) => GROUPS[group]!.match(e.eventType) && (!q || `${e.eventType} ${e.actor.label} ${e.executionId ?? ''} ${JSON.stringify(e.payload)}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, group, q],
  );

  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of everything that happened in this workspace: who did what, when, and through which client. The database refuses edits." />
      <Section>
        <div className="flex flex-col gap-3 border-b border-border p-3 md:flex-row md:items-center md:justify-between">
          <div role="tablist" aria-label="Filter events" className="flex flex-wrap gap-1">
            {GROUPS.map((g, i) => (
              <button key={g.label} role="tab" aria-selected={group === i} onClick={() => setGroup(i)} className={`rounded-md px-2.5 py-1 text-xs font-medium ${group === i ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-surface-2'}`}>
                {g.label}
              </button>
            ))}
          </div>
          <label className="relative block md:w-72">
            <span className="sr-only">Search audit events</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, event or ID" className="h-8 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent" />
          </label>
        </div>
        {error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={() => void reload()} />
          </div>
        ) : loading && !data ? (
          <LoadingRows rows={8} />
        ) : events.length === 0 ? (
          <EmptyState icon={<FileLock2 className="size-6" aria-hidden />} title="No matching events" />
        ) : (
          <ol className="divide-y divide-border">
            {events.map((e: AuditEvent) => (
              <li key={e.seq}>
                <button type="button" onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-2/60 sm:flex-nowrap">
                  <span className="w-14 shrink-0 font-mono text-[11px] text-fg-3 tabular">#{e.seq}</span>
                  <Badge tone={eventTone(e.eventType)}>{EVENT_LABEL[e.eventType] ?? EXTRA_LABELS[e.eventType] ?? e.eventType}</Badge>
                  <span className="min-w-0 basis-full truncate text-xs text-fg-2 sm:basis-auto sm:flex-1">
                    {e.actor.type} · {e.actor.label}
                    {e.executionId && (
                      <>
                        {' · '}
                        <Link to={`/app/executions/${e.executionId}`} onClick={(x) => x.stopPropagation()} className="font-mono text-accent hover:underline">
                          {e.executionId}
                        </Link>
                      </>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-fg-3" title={fmtDateTime(e.timestamp)}>
                    {fmtRelative(e.timestamp)}
                  </span>
                </button>
                {open === e.seq && (
                  <div className="space-y-2 px-4 pb-4">
                    <Json value={e.payload} />
                    <p className="font-mono text-[11px] text-fg-3">
                      {fmtDateTime(e.timestamp)} · payload sha256 {e.payloadSha256}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="border-t border-border px-4 py-2.5 text-xs text-fg-3">Showing the latest 200 events. Export a full execution trace from its inspector.</p>
      </Section>
    </>
  );
}
