import { KeyRound, Plus } from '../../components/icons';
import { useState } from 'react';
import { Badge, Button, CodeBlock, Dialog, EmptyState, LoadingRows, Section, useAsync, useToast } from '../../components/ui';
import { api, type ApiKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

export function KeysSettings() {
  const { refresh } = useAuth();
  const keys = useAsync(() => api.keys(), []);
  const toast = useToast();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [revoke, setRevoke] = useState<ApiKey | null>(null);

  return (
    <>
      <Section
        title="API keys"
        description="Workspace-scoped bearer keys for MCP clients and scripts. Keys act with member rights: they can run and recover, never approve or administer. Shown once; only the SHA-256 is stored."
        actions={
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setCreating(true);
              try {
                const r = await api.createKey(keyName.trim() || 'Unnamed key');
                setNewKey(r.key);
                setKeyName('');
                void keys.reload({ quiet: true });
                void refresh();
              } catch (err) {
                toast.push({ tone: 'bad', title: 'Could not create key', body: err instanceof Error ? err.message : String(err) });
              } finally {
                setCreating(false);
              }
            }}
          >
            <label htmlFor="keyname" className="sr-only">
              Key name
            </label>
            <input id="keyname" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Key name, e.g. claude-code" maxLength={60} className="h-8 w-48 rounded-md border border-border-strong bg-surface px-2.5 text-sm outline-none focus:border-accent" />
            <Button type="submit" size="sm" variant="primary" loading={creating} icon={<Plus className="size-3.5" aria-hidden />}>
              Create key
            </Button>
          </form>
        }
      >
        {newKey && (
          <div className="border-b border-border bg-ok-soft/40 p-4">
            <p className="mb-2 text-sm font-medium text-ok">New key created. Copy it now; it will not be shown again.</p>
            <CodeBlock label="REWIND_API_KEY" code={newKey} />
          </div>
        )}
        {keys.loading && !keys.data ? (
          <LoadingRows rows={2} />
        ) : keys.data?.keys.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-fg-2">
                  <th scope="col" className="px-4 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Key</th>
                  <th scope="col" className="px-3 py-2 font-medium">Created</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last used</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys.data.keys.map((k) => (
                  <tr key={k.id} className={k.revokedAt ? 'opacity-50' : ''}>
                    <td className="px-4 py-2.5 font-medium">{k.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{k.prefix}…</td>
                    <td className="px-3 py-2.5 text-xs text-fg-2">{fmtRelative(k.createdAt)}</td>
                    <td className="px-3 py-2.5 text-xs text-fg-2">{k.lastUsedAt ? fmtRelative(k.lastUsedAt) : 'never'}</td>
                    <td className="px-4 py-2.5 text-right">
                      {k.revokedAt ? (
                        <Badge tone="neutral">Revoked</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setRevoke(k)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<KeyRound className="size-6" aria-hidden />} title="No API keys yet">
            Create one to connect Claude Code, the MCP Inspector or your own agent.
          </EmptyState>
        )}
      </Section>

      <Dialog
        open={revoke !== null}
        onClose={() => setRevoke(null)}
        title={`Revoke "${revoke?.name}"?`}
        footer={
          <>
            <Button onClick={() => setRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!revoke) return;
                await api.revokeKey(revoke.id);
                setRevoke(null);
                void keys.reload({ quiet: true });
                toast.push({ tone: 'ok', title: 'Key revoked', body: 'Clients using it are rejected immediately.' });
              }}
            >
              Revoke key
            </Button>
          </>
        }
      >
        Any client using <code className="font-mono">{revoke?.prefix}…</code> will be rejected on its next request. This is recorded in the audit log.
      </Dialog>
    </>
  );
}
