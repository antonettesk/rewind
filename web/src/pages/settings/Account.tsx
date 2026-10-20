import { Laptop, RewindMark } from '../../components/icons';
import { useState, type FormEvent } from 'react';
import { Badge, Button, LoadingRows, Section, useAsync, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { SignInMethods, TwoFactor } from './SecuritySections';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

const input = 'h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent';

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

export function AccountSettings() {
  const { me, refresh } = useAuth();
  const guest = me?.user.kind === 'guest';
  return (
    <div className="space-y-6">
      {guest ? <UpgradeGuest onDone={refresh} /> : <Profile />}
      {!guest && <PasswordForm />}
      {!guest && <TwoFactor />}
      {!guest && <SignInMethods />}
      <Sessions />
    </div>
  );
}

function Profile() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me?.user.name ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Profile">
      <form
        className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.updateProfile(name.trim());
            await refresh();
            toast.push({ tone: 'ok', title: 'Profile updated' });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Name</span>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={input} />
            <Button type="submit" loading={busy} disabled={!name.trim() || name === me?.user.name}>
              Save
            </Button>
          </div>
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Email</span>
          <p className="flex h-9 items-center text-sm">{me?.user.email}</p>
        </div>
      </form>
    </Section>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 10) return setErr('Use at least 10 characters.');
    setBusy(true);
    setErr(null);
    try {
      const r = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      toast.push({ tone: 'ok', title: 'Password changed', body: r.otherSessionsSignedOut ? `${r.otherSessionsSignedOut} other session(s) were signed out.` : undefined });
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Password" description="Changing your password signs out every other session.">
      <form className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={submit} noValidate>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">New password</span>
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
        </label>
        <Button type="submit" variant="primary" loading={busy} disabled={!current || !next}>
          Change password
        </Button>
        {err && (
          <p role="alert" className="text-xs text-bad md:col-span-3">
            {err}
          </p>
        )}
      </form>
    </Section>
  );
}

function UpgradeGuest({ onDone }: { onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={<span className="flex items-center gap-2"><RewindMark className="size-4 text-accent" aria-hidden /> Keep your work: create an account</span>} description="Your guest workspace, executions and keys carry over. Guest workspaces are otherwise deleted automatically.">
      <form
        className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (form.password.length < 10) return setErr('Use at least 10 characters for the password.');
          setBusy(true);
          setErr(null);
          try {
            await api.upgradeGuest(form);
            await onDone();
            toast.push({ tone: 'ok', title: 'Account created', body: 'Your workspace is now permanent.' });
          } catch (x) {
            setErr(x instanceof Error ? x.message : String(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Your name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" className={input} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Work email</span>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" className={input} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-fg-2">Password</span>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className={input} />
        </label>
        <Button type="submit" variant="primary" loading={busy} disabled={!form.name || !form.email || !form.password}>
          Create account
        </Button>
        {err && (
          <p role="alert" className="text-xs text-bad md:col-span-4">
            {err}
          </p>
        )}
      </form>
    </Section>
  );
}

function Sessions() {
  const s = useAsync(() => api.sessions(), []);
  const toast = useToast();
  const others = s.data?.sessions.filter((x) => !x.current).length ?? 0;
  return (
    <Section
      title="Active sessions"
      description="Devices signed in to your account. Sessions expire automatically."
      actions={
        others > 0 && (
          <Button
            size="sm"
            onClick={async () => {
              const r = await api.revokeOtherSessions();
              void s.reload({ quiet: true });
              toast.push({ tone: 'ok', title: `Signed out ${r.signedOut} other session(s)` });
            }}
          >
            Sign out other sessions
          </Button>
        )
      }
    >
      {!s.data ? (
        <LoadingRows rows={2} />
      ) : (
        <ul className="divide-y divide-border">
          {s.data.sessions.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Laptop className="size-4 text-fg-3" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {describeAgent(x.userAgent)} {x.current && <Badge tone="ok">This device</Badge>}
                </p>
                <p className="text-xs text-fg-3">
                  Signed in {fmtRelative(x.createdAt)} · active {fmtRelative(x.lastSeenAt)} · expires {fmtRelative(x.expiresAt)}
                </p>
              </div>
              {!x.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.revokeSession(x.id);
                    void s.reload({ quiet: true });
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
