import { Download, KeyRound, ShieldCheck } from '../../components/icons';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, CodeBlock, LoadingRows, Section, useAsync, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';

const input = 'h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent';

export function TwoFactor() {
  const toast = useToast();
  const { refresh } = useAuth();
  const status = useAsync(() => api.mfaStatus(), []);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [managing, setManaging] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enabled = status.data?.enabled;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob([`REWIND recovery codes\nEach code works once.\n\n${(codes ?? []).join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rewind-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-accent" aria-hidden /> Two-factor authentication
        </span>
      }
      description="Require a code from an authenticator app (1Password, Google Authenticator, Authy…) at every sign-in, including after SSO."
      actions={enabled ? <Badge tone="ok">On</Badge> : status.data ? <Badge tone="warn">Off</Badge> : null}
    >
      <div className="space-y-4 p-4 text-sm">
        {codes ? (
          <div className="space-y-3">
            <p className="font-medium text-ok">Save these recovery codes somewhere safe. Each works once if you lose your device. They won&apos;t be shown again.</p>
            <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-code p-3 font-mono text-sm sm:grid-cols-5" aria-label="Recovery codes">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" icon={<Download className="size-3.5" aria-hidden />} onClick={download}>
                Download
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCodes(null)}>
                I&apos;ve saved them
              </Button>
            </div>
          </div>
        ) : !enabled && !setup ? (
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              run(async () => {
                setSetup(await api.mfaSetup());
              })
            }
          >
            Set up two-factor authentication
          </Button>
        ) : !enabled && setup ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-[auto_1fr]">
            <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg border border-border bg-white p-2" />
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await api.mfaEnable(code);
                  setCodes(r.recoveryCodes);
                  setSetup(null);
                  setCode('');
                  void status.reload({ quiet: true });
                  void refresh();
                  toast.push({ tone: 'ok', title: 'Two-factor authentication is on' });
                });
              }}
            >
              <p>1. Scan the QR code with your authenticator app, or enter this key manually:</p>
              <CodeBlock label="Setup key" code={setup.secret.replace(/(.{4})/g, '$1 ').trim()} />
              <label className="block">
                <span className="mb-1.5 block">2. Enter the 6-digit code it shows</span>
                <input
                  aria-label="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className={`${input} max-w-40 text-center font-mono tracking-[0.3em]`}
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                  Turn on
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-fg-2">
              On since {status.data?.enabledAt ? fmtRelative(status.data.enabledAt) : '—'} · {status.data?.recoveryCodesRemaining} recovery codes left.
            </p>
            {!managing ? (
              <Button size="sm" onClick={() => setManaging(true)}>
                Turn off or get new recovery codes…
              </Button>
            ) : (
              <form className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end" onSubmit={(e) => e.preventDefault()}>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-fg-2">Current password</span>
                  <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-fg-2">Authenticator or recovery code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} className={`${input} font-mono`} />
                </label>
                <Button
                  type="button"
                  loading={busy}
                  disabled={!code}
                  onClick={() =>
                    run(async () => {
                      const r = await api.mfaRecoveryCodes(code);
                      setCodes(r.recoveryCodes);
                      setCode('');
                      setManaging(false);
                      void status.reload({ quiet: true });
                    })
                  }
                >
                  New recovery codes
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  loading={busy}
                  disabled={!code}
                  onClick={() =>
                    run(async () => {
                      await api.mfaDisable(code, password || undefined);
                      setCode('');
                      setPassword('');
                      setManaging(false);
                      void status.reload({ quiet: true });
                      void refresh();
                      toast.push({ tone: 'warn', title: 'Two-factor authentication is off' });
                    })
                  }
                >
                  Turn off
                </Button>
              </form>
            )}
          </div>
        )}
        {err && (
          <p role="alert" className="text-xs text-bad">
            {err}
          </p>
        )}
      </div>
    </Section>
  );
}

export function SignInMethods() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const ids = useAsync(() => api.identities(), []);
  useEffect(() => {
    const linked = params.get('linked');
    if (linked) {
      toast.push({ tone: 'ok', title: `${linked} connected`, body: 'You can now sign in with it.' });
      setParams((p) => (p.delete('linked'), p), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const linked = ids.data?.identities ?? [];
  const available = (ids.data?.available ?? []).filter((p) => !linked.some((l) => l.provider === p.id));
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-accent" aria-hidden /> Sign-in methods
        </span>
      }
      description="Connect a company, Google or Microsoft account for single sign-on."
    >
      {!ids.data ? (
        <LoadingRows rows={1} />
      ) : (
        <div className="divide-y divide-border">
          {linked.map((l) => (
            <div key={l.provider} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{l.name}</span>{' '}
                <span className="text-fg-3">
                  · {l.email ?? 'no email'} · last used {l.lastLoginAt ? fmtRelative(l.lastLoginAt) : 'never'}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.unlinkIdentity(l.provider);
                    void ids.reload({ quiet: true });
                  } catch (x) {
                    toast.push({ tone: 'bad', title: 'Could not disconnect', body: x instanceof Error ? x.message : String(x) });
                  }
                }}
              >
                Disconnect
              </Button>
            </div>
          ))}
          {available.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="flex-1 text-fg-2">{p.name}</span>
              <Button
                size="sm"
                onClick={async () => {
                  const r = await api.linkIdentity(p.id);
                  window.location.assign(r.url);
                }}
              >
                Connect
              </Button>
            </div>
          ))}
          {!linked.length && !available.length && (
            <p className="px-4 py-3 text-sm text-fg-3">
              No single sign-on providers are configured on this server. An admin can enable Google, Microsoft or any OpenID Connect provider with environment variables (see Settings → Connect).
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
