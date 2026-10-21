import { ArrowRight, Check, Eye, EyeOff, KeyRound, Launch } from '../components/icons';
import { motion } from 'motion/react';
import { RewindDial } from './landing/RewindDial';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Logo } from '../components/Logo';
import { Button } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

function safeNext(next: string | null, fallback: string) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

function Shell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · REWIND`;
  }, [title]);
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.05fr]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Link to="/" aria-label="REWIND home">
          <Logo />
        </Link>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12"
        >
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-fg-2">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-6 text-sm text-fg-2">{footer}</div>
        </motion.div>
      </div>
      <aside className="dark relative hidden overflow-clip border-l border-white/10 bg-[#050608] text-white lg:block" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(70%_50%_at_100%_0%,rgba(79,70,229,.3),transparent_70%),radial-gradient(60%_40%_at_0%_100%,rgba(6,182,212,.14),transparent_70%)]" />
        <RewindDial className="absolute -bottom-[22rem] -right-[18rem] w-[52rem] opacity-80" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <p className="text-[2.4rem] font-semibold leading-[1.08] tracking-[-0.035em]">
            {['Every change recorded.', 'Every failure contained.'].map((line, i) => (
              <motion.span key={line} className="block" initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.9, delay: 0.15 + i * 0.12, ease: [0.16, 1, 0.3, 1] }}>
                {line}
              </motion.span>
            ))}
            <motion.span className="sheen block" initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.9, delay: 0.39, ease: [0.16, 1, 0.3, 1] }}>
              Every rewind verified.
            </motion.span>
          </p>
          <ul className="mt-10 space-y-3 text-sm text-white/60">
            {['State captured before each mutation', 'Compensations in reverse dependency order', 'Read-back verification, never assumed', 'Irreversible effects reported honestly'].map((t, i) => (
              <motion.li key={t} className="flex items-center gap-2.5" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, delay: 0.6 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}>
                <span className="flex size-5 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                  <Check className="size-3" />
                </span>
                {t}
              </motion.li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children(id, error ? errId : undefined)}
      {error ? (
        <p id={errId} className="mt-1.5 text-xs text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

const inputCls =
  'h-10 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm outline-none transition focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] aria-[invalid=true]:border-bad';

function PasswordInput({ id, value, onChange, describedBy, autoComplete, invalid }: { id: string; value: string; onChange: (v: string) => void; describedBy?: string; autoComplete: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={`${inputCls} pr-10`}
      />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-3 hover:text-fg" aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError) for (const i of e.issues ?? []) out[i.path || 'form'] ??= i.message;
  return out;
}

function GuestButton() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.guest();
          await refresh();
          nav('/onboarding');
        } finally {
          setBusy(false);
        }
      }}
      className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
    >
      <Launch className="size-4 text-accent" aria-hidden /> Continue as guest
    </button>
  );
}

/** Sign-in buttons for every SSO provider configured on the server (none are shown if none are configured). */
function SsoButtons({ next }: { next: string }) {
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.ssoProviders().then((r) => setProviders(r.providers)).catch(() => setProviders([]));
  }, []);
  if (!providers.length) return null;
  return (
    <div className="space-y-2">
      {providers.map((p) => (
        <a
          key={p.id}
          href={`/api/auth/sso/${p.id}/start?next=${encodeURIComponent(next)}`}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface text-sm font-medium hover:bg-surface-2"
        >
          <ProviderMark id={p.id} /> Continue with {p.name}
        </a>
      ))}
    </div>
  );
}

function ProviderMark({ id }: { id: string }) {
  if (id === 'google')
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2a7 7 0 0 1-6.6-4.8H1.4v3.1A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.4 14.5a7.2 7.2 0 0 1 0-4.6V6.8h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.8l4 3.1A7 7 0 0 1 12 4.8Z" />
      </svg>
    );
  if (id === 'microsoft')
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
        <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
        <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
        <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
        <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
      </svg>
    );
  return <KeyRound className="size-4 text-accent" aria-hidden />;
}

export function LoginPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(params.get('mfa') === '1');
  const [error, setError] = useState<string | null>(params.get('sso_error'));
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'), '/app');
  if (me) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login({ email, password });
      if (r.mfaRequired) {
        setMfa(true);
        return;
      }
      await refresh();
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.mfaLogin(code);
      await refresh();
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (mfa) {
    return (
      <Shell
        title="Two-factor authentication"
        subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes."
        footer={
          <button type="button" onClick={() => { setMfa(false); setCode(''); setError(null); }} className="font-medium text-accent hover:underline">
            Use a different account
          </button>
        }
      >
        <form onSubmit={submitCode} className="space-y-4" noValidate>
          <Field label="Authentication code">
            {(id) => (
              <input
                id={id}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={20}
                placeholder="123 456"
                className={`${inputCls} text-center font-mono text-lg tracking-[0.4em]`}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6} className="h-10 w-full rounded-lg">
            Verify <ArrowRight className="size-4" aria-hidden />
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="Welcome back"
      subtitle="Sign in to your REWIND workspace."
      footer={
        <>
          New here?{' '}
          <Link to={`/signup${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent hover:underline">
            Create a workspace
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <SsoButtons next={next} />
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email">{(id) => <input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />}</Field>
          <Field label="Password">{(id, d) => <PasswordInput id={id} value={password} onChange={setPassword} describedBy={d} autoComplete="current-password" />}</Field>
          <div className="-mt-2 text-right">
            <Link to="/forgot-password" className="text-xs font-medium text-accent hover:underline">
              Forgot password?
            </Link>
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="h-10 w-full rounded-lg">
            Sign in <ArrowRight className="size-4" aria-hidden />
          </Button>
          <Divider />
          <GuestButton />
        </form>
      </div>
    </Shell>
  );
}

export function SignupPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Only redirect visitors who arrive already signed in; a fresh signup goes to onboarding.
  const [arrivedSignedIn] = useState(() => me !== null);
  if (me && arrivedSignedIn) return <Navigate to={safeNext(params.get('next'), '/app')} replace />;
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const strength = passwordStrength(form.password);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = 'Enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(form.email)) local.email = 'Enter a valid email address.';
    if (form.password.length < 10) local.password = 'Use at least 10 characters.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.signup({ name: form.name, email: form.email, password: form.password, workspaceName: form.workspaceName || undefined });
      await refresh();
      // Coming from an invitation link: go back to it; otherwise start onboarding.
      const next = params.get('next');
      nav(next && next.startsWith('/invite/') ? next : '/onboarding', { replace: true });
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(Object.keys(fe).length ? fe : { form: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Create your workspace"
      subtitle="Free and local. Your workspace gets its own synthetic home, policies and API keys."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <div className="mb-4">
        <SsoButtons next={params.get('next') ?? '/onboarding'} />
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Your name" error={errors.name}>
          {(id, d) => <input id={id} autoComplete="name" value={form.name} onChange={(e) => set('name')(e.target.value)} aria-invalid={!!errors.name} aria-describedby={d} className={inputCls} />}
        </Field>
        <Field label="Work email" error={errors.email}>
          {(id, d) => <input id={id} type="email" autoComplete="email" value={form.email} onChange={(e) => set('email')(e.target.value)} aria-invalid={!!errors.email} aria-describedby={d} className={inputCls} />}
        </Field>
        <Field label="Password" error={errors.password} hint="At least 10 characters. Stored as a salted scrypt hash.">
          {(id, d) => <PasswordInput id={id} value={form.password} onChange={set('password')} describedBy={d} autoComplete="new-password" invalid={!!errors.password} />}
        </Field>
        {form.password && (
          <div className="flex items-center gap-2" aria-label={`Password strength: ${strength.label}`}>
            <div className="flex flex-1 gap-1">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`h-1 flex-1 rounded-full ${i < strength.score ? strength.color : 'bg-border'}`} />
              ))}
            </div>
            <span className="text-xs text-fg-3">{strength.label}</span>
          </div>
        )}
        <Field label="Workspace name (optional)">
          {(id) => <input id={id} value={form.workspaceName} placeholder="e.g. Acme agents" onChange={(e) => set('workspaceName')(e.target.value)} className={inputCls} />}
        </Field>
        {errors.form && (
          <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
            {errors.form}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy} className="h-10 w-full rounded-lg">
          Create workspace <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Divider />
        <GuestButton />
        <p className="text-center text-xs text-fg-3">Guest workspaces are temporary and deleted automatically.</p>
      </form>
    </Shell>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-xs text-fg-3">
      <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function passwordStrength(p: string) {
  let score = 0;
  if (p.length >= 10) score++;
  if (p.length >= 14) score++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) score++;
  if (/\d/.test(p) || /[^A-Za-z0-9]/.test(p)) score++;
  const label = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][score]!;
  const color = score <= 1 ? 'bg-bad' : score === 2 ? 'bg-warn' : 'bg-ok';
  return { score, label, color };
}
