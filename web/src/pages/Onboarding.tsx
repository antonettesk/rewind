import { ArrowRight, Check, KeyRound, Loader2, PlayCircle, Plug, RewindMark } from '../components/icons';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Logo } from '../components/Logo';
import { RewindTheater } from '../components/RewindTheater';
import { Button, CodeBlock, cx, useToast } from '../components/ui';
import { api, type ExecutionView } from '../lib/api';
import { useAuth } from '../lib/auth';

const STEPS = ['Workspace', 'See a rewind', 'Connect an agent', 'Ready'] as const;

export function OnboardingPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  useEffect(() => {
    document.title = 'Get started · Rewind';
  }, []);
  if (!me) return null;

  const finish = async () => {
    await api.completeOnboarding().catch(() => undefined);
    await refresh();
    nav('/app');
  };

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <button type="button" onClick={finish} className="text-sm text-fg-2 hover:text-fg">
            Skip to console
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <ol className="mb-10 grid grid-cols-4 gap-2" aria-label="Onboarding progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined}>
              <div className={cx('h-1 rounded-full transition-colors duration-500', i <= step ? 'bg-brand' : 'bg-border')} />
              <p className={cx('mt-2 text-xs', i === step ? 'font-medium text-fg' : 'text-fg-3')}>
                <span className="hidden sm:inline">{i + 1}. </span>
                {s}
              </p>
            </li>
          ))}
        </ol>
        <motion.div key={step} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          {step === 0 && <WorkspaceStep onNext={() => setStep(1)} />}
          {step === 1 && <RewindStep onNext={() => setStep(2)} />}
          {step === 2 && <ConnectStep onNext={() => setStep(3)} />}
          {step === 3 && <DoneStep onFinish={finish} />}
        </motion.div>
      </main>
    </div>
  );
}

function WorkspaceStep({ onNext }: { onNext: () => void }) {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.workspace.name ?? '');
  const [busy, setBusy] = useState(false);
  const guest = me?.user.kind === 'guest';
  return (
    <section>
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">Welcome{guest ? '' : `, ${me?.user.name.split(' ')[0]}`}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Let's make your first agent mistake recoverable.</h1>
      <p className="mt-3 max-w-2xl text-fg-2">
        Your workspace already has its own synthetic smart home, default safety policies, and an empty audit log. Nothing here touches a real device or account.
      </p>
      {guest && (
        <p className="mt-4 rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm text-fg-2">
          You're exploring as a guest. This workspace is temporary and is deleted automatically.{' '}
          <Link to="/app/settings/account" className="font-medium text-accent hover:underline">
            Create an account
          </Link>{' '}
          any time to keep it, with all your history.
        </p>
      )}
      <form
        className="mt-8 max-w-md"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (name.trim() && name !== me?.workspace.name) await api.renameWorkspace(name.trim());
            await refresh();
            onNext();
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="ws-name" className="mb-1.5 block text-sm font-medium">
          Workspace name
        </label>
        <input
          id="ws-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm outline-none focus:border-accent"
        />
        <Button type="submit" variant="primary" loading={busy} className="mt-4 h-10 rounded-lg">
          Continue <ArrowRight className="size-4" aria-hidden />
        </Button>
      </form>
    </section>
  );
}

function RewindStep({ onNext }: { onNext: () => void }) {
  const [view, setView] = useState<ExecutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const recovered = view?.execution.status === 'recovered';
  return (
    <section>
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">Step 2</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Watch a failure get rewound.</h1>
      <p className="mt-3 max-w-2xl text-fg-2">
        The request: <em>"Prepare the house for the weekend."</em> The thermostat and task list will change. Then the security hub rejects activation (a deliberately
        injected fault). Rewind halts, compensates the earlier steps newest-first, and reads each one back.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          loading={busy}
          className="h-10 rounded-lg"
          icon={<PlayCircle className="size-4" aria-hidden />}
          onClick={async () => {
            setBusy(true);
            try {
              setView(await api.runScenario('weekend-failure', true));
            } catch (e) {
              toast.push({ tone: 'bad', title: 'Run failed', body: e instanceof Error ? e.message : String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {view ? 'Run it again' : 'Run the scenario'}
        </Button>
        {view && (
          <Link to={`/app/executions/${view.execution.id}`} target="_blank" className="text-sm font-medium text-accent hover:underline">
            Open the full trace ↗
          </Link>
        )}
      </div>
      <div className="mt-6">
        <RewindTheater view={view} stepMs={480} />
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant={recovered ? 'primary' : 'secondary'} className="h-10 rounded-lg" onClick={onNext}>
          {recovered ? 'Next: connect your agent' : 'Skip'} <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function ConnectStep({ onNext }: { onNext: () => void }) {
  const { me, refresh } = useAuth();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = Boolean(me?.milestones.first_mcp_call);
  const url = `${window.location.origin}/mcp`;

  // Poll for the first MCP call made with an API key from this workspace.
  useEffect(() => {
    if (!key || connected) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [key, connected, refresh]);

  const shownKey = key ?? 'rwk_…';
  return (
    <section>
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">Step 3</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connect your agent over MCP.</h1>
      <p className="mt-3 max-w-2xl text-fg-2">Create a workspace API key, then point any Streamable HTTP MCP client at this server. We'll detect its first call.</p>

      <div className="mt-6 rounded-xl border border-border bg-surface p-5">
        {!key ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <KeyRound className="size-5 text-accent" aria-hidden />
              <div>
                <p className="text-sm font-medium">Workspace API key</p>
                <p className="text-xs text-fg-3">Shown once. Only its SHA-256 hash is stored.</p>
              </div>
            </div>
            <Button
              variant="primary"
              loading={busy}
              className="rounded-lg"
              onClick={async () => {
                setBusy(true);
                try {
                  setKey((await api.createKey('Onboarding key')).key);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create API key
            </Button>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium text-ok">Key created. Copy it now; you won't see it again.</p>
            <CodeBlock className="mt-3" label="REWIND_API_KEY" code={key} />
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CodeBlock label="Claude Code" code={`claude mcp add --transport http rewind ${url} \\\n  --header "Authorization: Bearer ${shownKey}"`} />
        <CodeBlock label="From this repo (official SDK client)" code={`REWIND_API_KEY=${shownKey} npm run demo:mcp`} />
      </div>

      <div className={cx('mt-6 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors', connected ? 'border-ok/40 bg-ok-soft text-ok' : 'border-border bg-surface-2/50 text-fg-2')} role="status">
        {connected ? <Check className="size-4" aria-hidden /> : key ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plug className="size-4" aria-hidden />}
        {connected ? 'Connected. Rewind received a tool call from your MCP client.' : key ? 'Waiting for your client’s first tools/list or tools/call…' : 'Create a key to start.'}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        {!connected && (
          <Button className="h-10 rounded-lg" onClick={onNext}>
            I'll do this later
          </Button>
        )}
        <Button variant={connected ? 'primary' : 'secondary'} className="h-10 rounded-lg" onClick={onNext} disabled={!connected}>
          Continue <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  const { me } = useAuth();
  const m = me?.milestones ?? {};
  const items = [
    { done: Boolean(m.workspace_created), label: 'Workspace provisioned with policies and a synthetic home' },
    { done: Boolean(m.first_verified_recovery), label: 'Watched a failure get rewound and verified' },
    { done: Boolean(m.first_api_key), label: 'Created a workspace API key' },
    { done: Boolean(m.first_mcp_call), label: 'Connected an MCP client' },
  ];
  return (
    <section className="text-center">
      <div className="bg-brand mx-auto flex size-14 items-center justify-center rounded-2xl text-white">
        <RewindMark className="size-6" aria-hidden />
      </div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">You're set up.</h1>
      <p className="mx-auto mt-3 max-w-xl text-fg-2">From here, every execution your agents run through Rewind is recorded, contained and recoverable where recovery is possible.</p>
      <ul className="mx-auto mt-8 max-w-md space-y-2 text-left">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm">
            <span className={cx('flex size-5 items-center justify-center rounded-full', i.done ? 'bg-ok text-white' : 'border border-border-strong')}>{i.done && <Check className="size-3" aria-hidden />}</span>
            <span className={i.done ? '' : 'text-fg-3'}>{i.label}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" className="mt-8 h-11 rounded-xl px-6" onClick={onFinish}>
        Open the console <ArrowRight className="size-4" aria-hidden />
      </Button>
    </section>
  );
}
