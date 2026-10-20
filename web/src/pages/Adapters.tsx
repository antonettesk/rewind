import { Blocks } from '../components/icons';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { CAPABILITY, POLICY_DECISION } from '../lib/strings';
import { Badge, CodeBlock, EmptyState, ErrorState, LabeledBadge, LoadingRows, PageHeader, Section, useAsync } from '../components/ui';

const SAMPLE = `import { z } from 'zod/v4';
import { AdapterError } from '../domain/errors.js';
import type { Adapter } from './types.js';

export function createCrmAdapter(crm: CrmClient): Adapter {
  const ref = (id: string) => ({ type: 'contact', id });
  return {
    id: 'crm', name: 'CRM', type: 'saas', version: '1.0.0',
    description: 'Contacts in the team CRM.', disclosure: 'Writes to the real CRM.',
    async health() { /* call a real ping endpoint */ },
    operations: [{
      name: 'contact.set_owner', title: 'Change contact owner', kind: 'mutation',
      description: 'Assign a contact to a different owner.',
      inputSchema: z.object({ contactId: z.string(), ownerId: z.string() }).strict(),
      permissions: ['crm.contacts.write'], timeoutMs: 5000,
      recovery: { capability: 'compensatable', idempotentCompensation: true,
                  summary: 'Reassigns the captured previous owner if the record is unchanged.' },
      resource: (i) => ref(i.contactId),
      read: async (r) => { const c = await crm.get(r.id); return { version: c.etag, data: { ownerId: c.ownerId } }; },
      execute: async (i) => crm.update(i.contactId, { ownerId: i.ownerId }),
      writtenVersion: (res) => res.etag,
      expectedAfter: (_before, i) => ({ ownerId: i.ownerId }),
      compensate: async ({ input, before, writtenVersion }) => {
        // Compare-and-set: never overwrite a change someone else made.
        await crm.update(input.contactId, { ownerId: before.data.ownerId }, { ifMatch: writtenVersion });
      },
    }],
  };
}`;

export function AdaptersPage() {
  const { data, error, loading, reload } = useAsync(() => api.adapters(), []);
  return (
    <>
      <PageHeader title="Adapters" description="The only way REWIND touches the outside world. Every operation declares, in code, what it changes and how it can be recovered. REWIND never infers recoverability." />
      {error ? <ErrorState error={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows /> : null}
      {data?.adapters.length === 0 && <EmptyState icon={<Blocks className="size-6" aria-hidden />} title="No adapters registered" />}
      <div className="space-y-6">
        {data?.adapters.map((a) => (
          <Section
            key={a.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {a.name} <code className="font-mono text-xs text-fg-3">{a.id}@{a.version}</code>
              </span>
            }
            description={a.description}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone="neutral" dot={false}>{a.type}</Badge>
                <Badge tone={a.health.status === 'healthy' ? 'ok' : a.health.status === 'degraded' ? 'warn' : 'bad'} title={`${a.health.detail} (checked ${fmtRelative(a.health.checkedAt)})`}>
                  {a.connection === 'local' ? 'Local' : 'Configured'} · {a.health.status}
                </Badge>
              </div>
            }
          >
            <p className="border-b border-border bg-warn-soft/50 px-4 py-2 text-xs text-fg-2">
              <strong className="text-fg">Disclosure:</strong> {a.disclosure} Health: {a.health.detail}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-fg-2">
                    <th scope="col" className="px-4 py-2 font-medium">Operation</th>
                    <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                    <th scope="col" className="px-3 py-2 font-medium">Recovery capability</th>
                    <th scope="col" className="px-3 py-2 font-medium">Permissions</th>
                    <th scope="col" className="px-3 py-2 font-medium">Policy now</th>
                    <th scope="col" className="px-4 py-2 font-medium">Timeout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {a.operations.map((o) => (
                    <tr key={o.key} className="align-top">
                      <td className="px-4 py-2.5">
                        <p className="font-medium">{o.title}</p>
                        <p className="font-mono text-xs text-fg-3">{o.name}</p>
                        <p className="mt-0.5 max-w-sm text-xs text-fg-2">{o.description}</p>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-fg-2">{o.kind}</td>
                      <td className="px-3 py-2.5">
                        <LabeledBadge map={CAPABILITY} value={o.recovery.capability} />
                        <p className="mt-1 max-w-xs text-xs text-fg-2">{o.recovery.summary}</p>
                        {o.kind === 'mutation' && o.recovery.capability !== 'irreversible' && (
                          <p className="mt-0.5 text-[11px] text-fg-3">{o.recovery.idempotentCompensation ? 'Compensation is idempotent (safe to retry)' : 'Compensation not idempotent'}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{o.permissions.join(', ')}</td>
                      <td className="px-3 py-2.5">
                        <LabeledBadge map={POLICY_DECISION} value={o.policy.decision} />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-fg-2 tabular">{o.timeoutMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        ))}

        <Section title="Add your own adapter" description="Implement the Adapter interface and register it in src/services/app.ts. Registration validates the declarations and fails loudly if they are inconsistent.">
          <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="text-sm text-fg-2">
              <p className="font-medium text-fg">An action counts as recoverable only if all of these are true:</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                <li>The operation declares <code>compensatable</code> or <code>rollback</code> and registers a handler.</li>
                <li>The resource can be read, so REWIND captures its state <em>before</em> the change.</li>
                <li>The write reports its resulting version, so compensation can refuse to overwrite a later change.</li>
                <li>After compensation, reading the resource back matches the captured original.</li>
              </ol>
              <p className="mt-3">Anything else is reported as <em>recovery unavailable</em>, <em>needs manual review</em> or <em>recovery failed</em>. Never as recovered.</p>
              <p className="mt-3">See <code>docs/adapters.md</code> for the full contract.</p>
            </div>
            <CodeBlock label="example: src/adapters/crm.ts (illustrative)" code={SAMPLE} />
          </div>
        </Section>
      </div>
    </>
  );
}
