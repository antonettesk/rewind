import { ArrowRight, CheckCircle2, Users } from '../components/icons';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Logo } from '../components/Logo';
import { Button } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const input =
  'h-10 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm outline-none transition focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)]';

function Card({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Rewind`;
  }, [title]);
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden />
      <Link to="/" className="relative mb-8" aria-label="Rewind home">
        <Logo />
      </Link>
      <div className="surface-raised relative w-full max-w-sm rounded-2xl border border-border p-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-fg-2">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setSent((await api.forgotPassword(email)).message);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Reset your password" subtitle="Enter your account email and we'll send a one-time reset link.">
      {sent ? (
        <div className="space-y-4 text-sm">
          <p className="flex items-start gap-2 text-ok">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> {sent}
          </p>
          <p className="text-xs text-fg-3">The link is valid for 30 minutes and works once. On a self-hosted server without email delivery configured, the operator can find it in the server log.</p>
          <Link to="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          </label>
          {err && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
              {err}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="h-10 w-full rounded-lg">
            Send reset link
          </Button>
          <p className="text-center text-sm text-fg-2">
            <Link to="/login" className="text-accent hover:underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </Card>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setErr('Use at least 10 characters.');
    setBusy(true);
    setErr(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => nav('/login'), 1500);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Choose a new password" subtitle="Every existing session will be signed out.">
      {done ? (
        <p className="flex items-center gap-2 text-sm text-ok">
          <CheckCircle2 className="size-4" aria-hidden /> Password updated. Taking you to sign in…
        </p>
      ) : !token ? (
        <p className="text-sm text-bad">This page needs a reset link. Request a new one from the sign-in page.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">New password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
            <span className="mt-1.5 block text-xs text-fg-3">At least 10 characters.</span>
          </label>
          {err && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
              {err}{' '}
              {/expired|invalid|used/i.test(err) && (
                <Link to="/forgot-password" className="font-medium underline">
                  Request a new link
                </Link>
              )}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="h-10 w-full rounded-lg">
            Set password
          </Button>
        </form>
      )}
    </Card>
  );
}

export function InvitePage() {
  const { token = '' } = useParams();
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewInvitation>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.previewInvitation(token).then(setPreview).catch((x) => setErr(x instanceof Error ? x.message : String(x)));
  }, [token]);
  const next = encodeURIComponent(`/invite/${token}`);

  return (
    <Card title="You're invited" subtitle={preview ? <>Join <strong className="text-fg">{preview.workspaceName}</strong> on Rewind.</> : undefined}>
      {err ? (
        <p className="text-sm text-bad">{err}</p>
      ) : !preview ? (
        <div className="skeleton h-24" />
      ) : !preview.valid ? (
        <p className="text-sm text-bad">This invitation has expired, been revoked or already been used. Ask {preview.inviterName} for a new link.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-4 py-3">
            <Users className="size-5 text-accent" aria-hidden />
            <p className="text-sm">
              {preview.inviterName} invited you as <strong className="capitalize">{preview.role}</strong>.
            </p>
          </div>
          {me && me.user.kind !== 'guest' ? (
            <Button
              variant="primary"
              loading={busy}
              className="h-10 w-full rounded-lg"
              onClick={async () => {
                setBusy(true);
                try {
                  await api.acceptInvitation(token);
                  await refresh();
                  nav('/app');
                } catch (x) {
                  setErr(x instanceof Error ? x.message : String(x));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Join as {me.user.name} <ArrowRight className="size-4" aria-hidden />
            </Button>
          ) : (
            <div className="space-y-2">
              <Link to={`/signup?next=${next}`} className="flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-fg hover:opacity-90">
                Create an account to join
              </Link>
              <Link to={`/login?next=${next}`} className="flex h-10 items-center justify-center rounded-lg border border-border-strong text-sm font-medium hover:bg-surface-2">
                I already have an account
              </Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
