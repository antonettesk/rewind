import { Link2, UserPlus } from '../../components/icons';
import { useState } from 'react';
import { Badge, Button, CodeBlock, Dialog, EmptyState, ErrorState, LoadingRows, Section, useAsync, useToast } from '../../components/ui';
import { api, type Member, type Role } from '../../lib/api';
import { useAuth, useRole } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including deleting the workspace',
  admin: 'Members, keys, webhooks, policies and approvals',
  member: 'Run executions and request recovery',
  viewer: 'Read-only',
};

export function MembersSettings() {
  const { me, refresh } = useAuth();
  const { can } = useRole();
  const toast = useToast();
  const members = useAsync(() => api.members(), []);
  const invites = useAsync(() => (can('admin') ? api.invitations() : Promise.resolve({ invitations: [] })), [can('admin')]);
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('member');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<{ url: string; emailed: boolean; mailer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const guest = me?.workspace.kind === 'guest';

  const changeRole = async (m: Member, r: Role) => {
    try {
      await api.setMemberRole(m.userId, r);
      void members.reload({ quiet: true });
      if (m.userId === me?.user.id) void refresh();
      toast.push({ tone: 'ok', title: `${m.name} is now ${r}` });
    } catch (x) {
      toast.push({ tone: 'bad', title: 'Role not changed', body: x instanceof Error ? x.message : String(x) });
    }
  };

  return (
    <div className="space-y-6">
      {can('admin') && (
        <Section title="Invite people" description="Create a one-time invitation link (valid 7 days). Add an email to send it, if email delivery is configured.">
          {guest ? (
            <p className="p-4 text-sm text-fg-2">Guest workspaces can't invite people. Upgrade to a full account in Account settings first.</p>
          ) : (
            <form
              className="flex flex-col gap-3 p-4 md:flex-row md:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api.createInvitation(role, email.trim() || undefined);
                  setLink({ url: r.url, emailed: r.emailed, mailer: r.mailer });
                  setEmail('');
                  void invites.reload({ quiet: true });
                } catch (x) {
                  toast.push({ tone: 'bad', title: 'Could not create invitation', body: x instanceof Error ? x.message : String(x) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="block flex-1">
                <span className="mb-1.5 block text-xs font-medium text-fg-2">Email (optional)</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-fg-2">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="h-9 rounded-md border border-border-strong bg-surface px-2 text-sm outline-none focus:border-accent">
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              <Button type="submit" variant="primary" loading={busy} icon={<UserPlus className="size-4" aria-hidden />}>
                Create invite link
              </Button>
            </form>
          )}
          {link && (
            <div className="border-t border-border bg-ok-soft/30 p-4">
              <p className="mb-2 text-sm font-medium text-ok">
                Invitation created.{' '}
                {link.emailed && link.mailer === 'log' ? 'Email delivery is not configured, so the message was written to the server log. Share this link directly:' : 'Share this link with your teammate:'}
              </p>
              <CodeBlock label="Invitation link (one use, 7 days)" code={link.url} />
            </div>
          )}
        </Section>
      )}

      <Section title="Members" description="Roles are enforced on the server for every API and MCP call.">
        {members.error ? (
          <div className="p-4">
            <ErrorState error={members.error} onRetry={() => void members.reload()} />
          </div>
        ) : !members.data ? (
          <LoadingRows rows={2} />
        ) : (
          <ul className="divide-y divide-border">
            {members.data.members.map((m) => {
              const self = m.userId === me?.user.id;
              // The server refuses to leave a workspace without an owner; don't offer it.
              const lastOwner = m.role === 'owner' && members.data!.members.filter((x) => x.role === 'owner').length <= 1;
              const editable = can('admin') && !(m.role === 'owner' && !can('owner')) && !lastOwner;
              return (
                <li key={m.userId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <span className="bg-brand flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white">
                    {m.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {m.name} {self && <span className="text-fg-3">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-fg-3">
                      {m.email ?? 'guest'} · joined {fmtRelative(m.joinedAt)} · last sign-in {m.lastLoginAt ? fmtRelative(m.lastLoginAt) : 'never'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editable ? (
                      <select
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        onChange={(e) => void changeRole(m, e.target.value as Role)}
                        title={ROLE_HELP[m.role]}
                        className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm outline-none focus:border-accent"
                      >
                        {(can('owner') ? (['owner', 'admin', 'member', 'viewer'] as Role[]) : (['admin', 'member', 'viewer'] as Role[])).map((r) => (
                          <option key={r} value={r}>
                            {r[0]!.toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'} dot={false} title={ROLE_HELP[m.role]}>
                        {m.role}
                      </Badge>
                    )}
                    {(editable || (self && !lastOwner)) && (
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                        {self ? 'Leave' : 'Remove'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <dl className="grid grid-cols-2 gap-3 border-t border-border px-4 py-3 text-xs sm:grid-cols-4">
          {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
            <div key={r}>
              <dt className="font-medium capitalize">{r}</dt>
              <dd className="text-fg-3">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {can('admin') && (
        <Section title="Invitations">
          {invites.data?.invitations.length ? (
            <ul className="divide-y divide-border">
              {invites.data.invitations.map((i) => {
                const state = i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : new Date(i.expiresAt) < new Date() ? 'expired' : 'open';
                return (
                  <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Link2 className="size-4 text-fg-3" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">
                      {i.email ?? 'Link invitation'} · <span className="capitalize">{i.role}</span>
                      <span className="text-xs text-fg-3"> · created {fmtRelative(i.createdAt)}</span>
                    </span>
                    <Badge tone={state === 'open' ? 'info' : state === 'accepted' ? 'ok' : 'neutral'}>{state}</Badge>
                    {state === 'open' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await api.revokeInvitation(i.id);
                          void invites.reload({ quiet: true });
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No invitations yet" />
          )}
        </Section>
      )}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing?.userId === me?.user.id ? 'Leave this workspace?' : `Remove ${removing?.name}?`}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!removing) return;
                try {
                  await api.removeMember(removing.userId);
                  setRemoving(null);
                  if (removing.userId === me?.user.id) window.location.assign('/app');
                  else void members.reload({ quiet: true });
                } catch (x) {
                  toast.push({ tone: 'bad', title: 'Could not remove', body: x instanceof Error ? x.message : String(x) });
                }
              }}
            >
              {removing?.userId === me?.user.id ? 'Leave' : 'Remove'}
            </Button>
          </>
        }
      >
        Their access to this workspace ends immediately and their sessions in it are signed out. Their past actions stay in the audit log.
      </Dialog>
    </div>
  );
}
