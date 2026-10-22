import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, Button, Dialog, LoadingRows, Section, Stat, useAsync, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useRole } from '../../lib/auth';
import { fmtDuration, fmtNumber } from '../../lib/format';

export function GeneralSettings() {
  const { me, refresh } = useAuth();
  const { can } = useRole();
  const nav = useNavigate();
  const toast = useToast();
  const usage = useAsync(() => api.usage(), []);
  const activation = useAsync(() => api.activation(), []);
  const settings = useAsync(() => api.settings(), []);
  const [name, setName] = useState(me?.workspace.name ?? '');
  const [saving, setSaving] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const u = usage.data;
  const a = activation.data;
  const month = u ? new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(u.periodStart)) : '';

  return (
    <div className="space-y-6">
      <Section title="Workspace" description="Everything is scoped to this workspace. Clients can never choose a different one.">
        <form
          className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              await api.renameWorkspace(name.trim());
              await refresh();
              toast.push({ tone: 'ok', title: 'Workspace renamed' });
            } catch (x) {
              toast.push({ tone: 'bad', title: 'Rename failed', body: x instanceof Error ? x.message : String(x) });
            } finally {
              setSaving(false);
            }
          }}
        >
          <div>
            <label htmlFor="ws" className="mb-1.5 block text-xs font-medium text-fg-2">
              Name
            </label>
            <div className="flex gap-2">
              <input id="ws" value={name} disabled={!can('admin')} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-9 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent disabled:opacity-60" />
              {can('admin') && (
                <Button type="submit" loading={saving} disabled={!name.trim() || name === me?.workspace.name}>
                  Save
                </Button>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-fg-3">Workspace ID</dt>
              <dd className="font-mono">{me?.workspace.id}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Your role</dt>
              <dd className="capitalize">{me?.workspace.role}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Type</dt>
              <dd>{me?.workspace.kind === 'guest' ? <Badge tone="warn">Guest · temporary</Badge> : <Badge tone="ok">Standard</Badge>}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Environment</dt>
              <dd className="font-mono">{settings.data?.environment ?? '—'}</dd>
            </div>
          </dl>
        </form>
      </Section>

      <Section title={`Usage in ${month || 'this month'}`} description="Counted from stored records in this workspace. Rewind is self-hosted; there is no metered billing.">
        {u ? (
          <div className="grid grid-cols-2 divide-border sm:grid-cols-4 lg:grid-cols-7 lg:divide-x">
            <Stat label="Executions" value={fmtNumber(u.executions)} />
            <Stat label="Via MCP" value={fmtNumber(u.mcpExecutions)} />
            <Stat label="Verified recoveries" value={fmtNumber(u.verifiedRecoveries)} tone="ok" />
            <Stat label="Failed recoveries" value={fmtNumber(u.failedRecoveries)} tone={u.failedRecoveries ? 'warn' : undefined} />
            <Stat label="Approvals" value={fmtNumber(u.approvals)} />
            <Stat label="Members" value={fmtNumber(u.members)} />
            <Stat label="Active keys" value={fmtNumber(u.activeApiKeys)} />
          </div>
        ) : (
          <LoadingRows rows={1} />
        )}
      </Section>

      <Section title="Activation" description="Time from workspace creation to each milestone, measured locally from real events. Never sent anywhere.">
        {a ? (
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat label="First execution" value={fmtDuration(a.timeToFirstExecutionMs)} />
            <Stat label="First verified recovery" value={fmtDuration(a.timeToFirstVerifiedRecoveryMs)} />
            <Stat label="First MCP call (API key)" value={fmtDuration(a.timeToFirstMcpCallMs)} />
          </div>
        ) : (
          <LoadingRows rows={1} />
        )}
      </Section>

      <Section title="Data retention">
        <div className="space-y-3 p-4 text-sm text-fg-2">
          <p>
            Finished executions older than <strong className="text-fg">{settings.data?.retentionDays ?? 30} days</strong> are deleted hourly with their steps, snapshots, recovery records and audit
            events. Guest workspaces are deleted after <strong className="text-fg">{settings.data?.guestRetentionHours ?? 48} hours</strong>. Payloads are redacted before storage and capped at 64 KB.
          </p>
          {can('admin') && (
            <Button size="sm" onClick={() => setPurgeOpen(true)}>
              Apply retention now
            </Button>
          )}
        </div>
      </Section>

      {can('owner') && (
        <section className="rounded-lg border border-bad/40">
          <header className="border-b border-bad/30 px-4 py-3">
            <h2 className="text-sm font-semibold text-bad">Danger zone</h2>
          </header>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-fg-2">Permanently delete this workspace, its members' access, keys, webhooks, policies, executions and audit history.</p>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              Delete workspace
            </Button>
          </div>
        </section>
      )}

      <Dialog
        open={purgeOpen}
        onClose={() => setPurgeOpen(false)}
        title="Apply retention now?"
        footer={
          <>
            <Button onClick={() => setPurgeOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const r = await api.purge();
                setPurgeOpen(false);
                toast.push({ tone: 'ok', title: 'Retention applied', body: `${r.executions} execution(s) deleted.` });
              }}
            >
              Delete expired history
            </Button>
          </>
        }
      >
        Permanently deletes finished executions older than {settings.data?.retentionDays ?? 30} days. Open and in-progress executions are kept.
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setErr(null);
        }}
        title="Delete this workspace?"
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={confirm !== me?.workspace.name}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api.deleteWorkspace(confirm);
                  await refresh();
                  nav('/');
                } catch (x) {
                  setErr(x instanceof Error ? x.message : String(x));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p>This cannot be undone. Type the workspace name to confirm:</p>
        <p className="mt-2 font-mono text-fg">{me?.workspace.name}</p>
        <label className="mt-3 block">
          <span className="sr-only">Workspace name</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-fg outline-none focus:border-bad" />
        </label>
        {err && (
          <p role="alert" className="mt-3 rounded bg-bad-soft px-3 py-2 text-xs text-bad">
            {err}
          </p>
        )}
      </Dialog>
    </div>
  );
}
