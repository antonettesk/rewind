import { Send, Webhook as WebhookIcon } from '../../components/icons';
import { useState } from 'react';
import { Badge, Button, CodeBlock, Dialog, EmptyState, LoadingRows, Section, useAsync, useToast } from '../../components/ui';
import { api, type Webhook } from '../../lib/api';
import { fmtRelative } from '../../lib/format';

const EVENT_HELP: Record<string, string> = {
  'execution.needs_attention': 'Partially recovered or recovery failed: a person should look',
  'execution.recovered': 'Every effect restored and verified',
  'execution.failed': 'Failed with nothing to undo, or automatic recovery is off',
  'execution.succeeded': 'All steps completed',
  'approval.requested': 'A step is waiting for a human approval',
};

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: "Rewind-Signature: t=<unix>,v1=<hex>"
export function verify(secret: string, header: string, rawBody: string) {
  const [, t, v1] = header.match(/^t=(\\d+),v1=([a-f0-9]{64})$/) ?? [];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  return timingSafeEqual(expected, Buffer.from(v1!, 'hex'));
}`;

export function WebhooksSettings() {
  const hooks = useAsync(() => api.webhooks(), []);
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['execution.needs_attention', 'approval.requested']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Webhook | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const all = hooks.data?.events ?? Object.keys(EVENT_HELP);

  return (
    <div className="space-y-6">
      <Section title="Add a webhook" description="REWIND POSTs a signed JSON event when an execution needs attention, recovers, succeeds, or waits for approval. HTTPS only; private addresses are refused.">
        <form
          className="space-y-4 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api.createWebhook({ url: url.trim(), description: description.trim() || undefined, events });
              setSecret(r.secret);
              setUrl('');
              setDescription('');
              void hooks.reload({ quiet: true });
            } catch (x) {
              setError(x instanceof Error ? x.message : String(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-fg-2">Endpoint URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://hooks.example.com/rewind" className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 font-mono text-sm outline-none focus:border-accent" aria-invalid={Boolean(error)} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-fg-2">Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="e.g. On-call Slack relay" className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent" />
            </label>
          </div>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-fg-2">Events</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {all.map((ev) => (
                <label key={ev} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents((xs) => (e.target.checked ? [...xs, ev] : xs.filter((x) => x !== ev)))} className="mt-0.5 size-4 accent-[var(--accent)]" />
                  <span>
                    <code className="font-mono text-xs">{ev}</code>
                    <span className="block text-xs text-fg-3">{EVENT_HELP[ev]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="rounded bg-bad-soft px-3 py-2 text-xs text-bad">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={!url.trim() || !events.length} icon={<WebhookIcon className="size-4" aria-hidden />}>
            Add webhook
          </Button>
        </form>
        {secret && (
          <div className="space-y-3 border-t border-border bg-ok-soft/30 p-4">
            <p className="text-sm font-medium text-ok">Webhook added. Copy the signing secret now; it won't be shown again.</p>
            <CodeBlock label="Signing secret" code={secret} />
            <CodeBlock label="Verify a delivery (Node.js)" code={VERIFY_SNIPPET} />
          </div>
        )}
      </Section>

      <Section title="Webhooks">
        {hooks.loading && !hooks.data ? (
          <LoadingRows rows={2} />
        ) : hooks.data?.webhooks.length ? (
          <ul className="divide-y divide-border">
            {hooks.data.webhooks.map((h) => (
              <li key={h.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{h.url}</p>
                  <p className="truncate text-xs text-fg-3">
                    {h.description ? `${h.description} · ` : ''}
                    {h.events.join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-fg-3">
                    Last delivery:{' '}
                    {h.lastDelivery ? (
                      <>
                        <Badge tone={h.lastDelivery.status === 'delivered' ? 'ok' : 'bad'}>{h.lastDelivery.status}</Badge> {h.lastDelivery.eventType} · {fmtRelative(h.lastDelivery.createdAt)}
                      </>
                    ) : (
                      'none yet'
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-fg-2">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={h.enabled}
                      aria-label={`Enable webhook ${h.url}`}
                      onChange={async (e) => {
                        await api.setWebhookEnabled(h.id, e.target.checked);
                        void hooks.reload({ quiet: true });
                      }}
                      className="size-4 accent-[var(--accent)]"
                    />
                    Enabled
                  </label>
                  <Button
                    size="sm"
                    icon={<Send className="size-3.5" aria-hidden />}
                    onClick={async () => {
                      const r = await api.testWebhook(h.id);
                      void hooks.reload({ quiet: true });
                      toast.push({ tone: r.delivery.status === 'delivered' ? 'ok' : 'bad', title: r.delivery.status === 'delivered' ? 'Test delivered' : 'Test failed', body: r.delivery.error ?? `HTTP ${r.delivery.responseCode} in ${r.delivery.durationMs} ms` });
                    }}
                  >
                    Send test
                  </Button>
                  <Button size="sm" onClick={() => setInspect(h)}>
                    Deliveries
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(h)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<WebhookIcon className="size-6" aria-hidden />} title="No webhooks yet">
            Route "needs attention" to your on-call channel so nobody has to watch the console.
          </EmptyState>
        )}
      </Section>

      <DeliveriesDialog hook={inspect} onClose={() => setInspect(null)} />

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete this webhook?"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!removing) return;
                await api.deleteWebhook(removing.id);
                setRemoving(null);
                void hooks.reload({ quiet: true });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        Deliveries to <code className="font-mono">{removing?.url}</code> stop immediately and its delivery log is removed.
      </Dialog>
    </div>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Webhook | null; onClose: () => void }) {
  const d = useAsync(() => (hook ? api.webhookDeliveries(hook.id) : Promise.resolve({ deliveries: [] })), [hook?.id]);
  return (
    <Dialog open={hook !== null} onClose={onClose} title="Recent deliveries" footer={<Button onClick={onClose}>Close</Button>}>
      {d.data?.deliveries.length ? (
        <ul className="max-h-80 divide-y divide-border overflow-auto text-xs">
          {d.data.deliveries.map((x) => (
            <li key={x.id} className="flex items-center gap-2 py-2">
              <Badge tone={x.status === 'delivered' ? 'ok' : 'bad'}>{x.status}</Badge>
              <span className="font-mono">{x.eventType}</span>
              <span className="text-fg-3">
                #{x.attempt} · {x.responseCode ?? '—'} · {x.durationMs ?? '—'} ms
              </span>
              <span className="ml-auto text-fg-3">{fmtRelative(x.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No deliveries recorded yet.</p>
      )}
    </Dialog>
  );
}
