import { AgentMark, ArrowRight, ChevronDown, ClipboardCheck, FileLock2, Fingerprint, GitBranch, KeyRound, Launch, Lock, RewindMark, RotateCcw, Shield, ShieldCheck, UserCheck, Webhook } from '../components/icons';
import { AnimatePresence, motion, useMotionValueEvent, useScroll, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Logo } from '../components/Logo';
import { CopyButton, cx, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CountUp, Magnetic, Reveal, ScrollProgress, ScrollWords, SpotlightCard, Terminal, TiltIn, useActiveStep, WordRotator } from './landing/Bits';
import { AskBox } from './landing/AskBox';
import { RewindDial } from './landing/RewindDial';
import { Playground } from './landing/Playground';

const STORY = [
  { icon: FileLock2, title: 'Record', body: 'Before any write, Rewind checks policy, leases the resource and snapshots it. After the write, it snapshots again and keeps the version it produced.', code: 'snapshot.captured · before v1\npolicy.evaluated · allow\nsnapshot.captured · after v2' },
  { icon: Shield, title: 'Contain', body: 'The first failure halts forward progress. Timeouts are treated as unknown, never retried blindly, and reconciled by reading the resource back.', code: 'action.failed · SECURITY_HUB_REJECTED\neffect: none\nexecution.halted · 0 steps skipped' },
  { icon: RotateCcw, title: 'Compensate', body: 'Only steps with a registered compensation are undone, newest first along dependencies, with compare-and-set so a human’s later change is never overwritten.', code: 'recovery.planned · undo #2 → #1\ncompensation.started · #2\ncompare-and-set · v2 == v2 ✓' },
  { icon: ClipboardCheck, title: 'Verify', body: 'A handler returning is not proof. Rewind reads every resource back and compares it to the captured original. Anything that doesn’t match is reported, by name.', code: 'verification.passed · #2 v3 == original\nverification.passed · #1 v3 == original\nrecovery.completed · recovered' },
];

const CAPABILITIES: [string, 'compensatable' | 'irreversible' | 'rollback'][] = [
  ['Calendar event created', 'compensatable'],
  ['CRM owner reassigned', 'compensatable'],
  ['Email sent to a customer', 'irreversible'],
  ['Feature flag flipped', 'compensatable'],
  ['Database row updated', 'rollback'],
  ['Refund issued', 'irreversible'],
  ['Thermostat set to away', 'compensatable'],
  ['Ticket closed', 'compensatable'],
  ['Secret shared in chat', 'irreversible'],
  ['Inventory reserved', 'compensatable'],
];

const FAQ: [string, string][] = [
  ['Can Rewind undo a sent email?', 'No, and it says so. Operations declare whether they are compensatable, rollback-capable or irreversible. Irreversible effects are never "undone"; they are reported as unresolved side effects, and you can require human approval before they run.'],
  ['Does an LLM decide what gets rolled back?', 'Never. Eligibility, ordering, conflict detection and verification are deterministic functions over recorded state and declared capabilities. The playground above runs that exact code.'],
  ['What if someone changes the record after the agent did?', 'Compensation is compare-and-set on the version Rewind’s own write produced. If the resource moved on, Rewind refuses to overwrite it and flags it for manual review.'],
  ['How do agents connect?', 'Any MCP client over Streamable HTTP (Claude Code, the MCP Inspector, your own agent) with a workspace API key. Approvals stay in the console; no MCP tool can approve an action.'],
  ['Is it secure enough for a team?', 'Roles enforced server-side, SSO via OpenID Connect, TOTP two-factor with recovery codes, account lockout, hashed secrets, append-only audit, signed webhooks, strict CSP. Self-hosted: your data stays with you.'],
];

export function LandingPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const hero = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: hero, offset: ['start start', 'end start'] });
  const heroY = useTransform(scrollYProgress, [0, 1], [0, 160]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.6], [1, 0.94]);
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (v) => setScrolled(v > 24));
  const story = useActiveStep(STORY.length);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    document.title = 'Rewind · Undo for AI agents, with proof';
  }, []);

  async function tryDemo() {
    if (me) return nav('/app/demo');
    setBusy(true);
    try {
      await api.guest();
      await refresh();
      nav('/onboarding');
    } catch (e) {
      toast.push({ tone: 'bad', title: 'Could not start the demo', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** Run the visitor's own request in the live demo: a guest workspace, a real MCP agent, a failure on the last step. */
  async function runRequest(request: string, opts: { voice: boolean }) {
    const to = `/app/demo?${new URLSearchParams({ request, autorun: '1', ...(opts.voice ? { voice: '1' } : {}) })}`;
    if (me) return nav(to);
    setBusy(true);
    try {
      await api.guest();
      await refresh();
      nav(to);
    } catch (e) {
      toast.push({ tone: 'bad', title: 'Could not start the demo', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const ActiveIcon = STORY[story.active]!.icon;

  return (
    <div
      className="dark min-h-dvh overflow-x-clip bg-[#050608] text-white selection:bg-indigo-500/40"
      onMouseMove={(e) => {
        e.currentTarget.style.setProperty('--mx', `${e.clientX}px`);
        e.currentTarget.style.setProperty('--my', `${e.clientY}px`);
      }}
    >
      {/* Cursor spotlight */}
      <div className="pointer-events-none fixed inset-0 z-0 hidden bg-[radial-gradient(600px_circle_at_var(--mx,50%)_var(--my,20%),rgba(99,102,241,.10),transparent_40%)] [@media(hover:hover)_and_(pointer:fine)]:block" aria-hidden />

      <ScrollProgress />
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-50 px-3">
        <div
          className={cx(
            'mx-auto mt-3 flex items-center justify-between rounded-2xl border px-4 transition-all duration-500 ease-[cubic-bezier(.16,1,.3,1)] sm:px-5 lg:backdrop-blur-xl',
            scrolled ? 'h-12 max-w-4xl border-white/10 bg-[#07080b]/90 shadow-[0_8px_32px_-12px_rgba(0,0,0,.8)] lg:bg-black/55' : 'h-14 max-w-6xl border-transparent bg-transparent',
          )}
        >
          <Link to="/" aria-label="Rewind home">
            <Logo />
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-7 text-sm text-white/60 md:flex">
            <a href="#playground" className="hover:text-white">Playground</a>
            <a href="#how" className="hover:text-white">How it works</a>
            <a href="#mcp" className="hover:text-white">MCP</a>
            <a href="#security" className="hover:text-white">Security</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            {me ? (
              <Link to="/app" className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white px-3.5 text-sm font-semibold text-black hover:bg-white/90">
                Open console <ArrowRight className="size-4" aria-hidden />
              </Link>
            ) : (
              <>
                <Link to="/login" className="hidden h-9 items-center rounded-xl px-3 text-sm font-medium text-white/70 hover:text-white sm:inline-flex">
                  Sign in
                </Link>
                <Link to="/signup" className="inline-flex h-9 items-center rounded-xl bg-white px-3.5 text-sm font-semibold text-black hover:bg-white/90">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section ref={hero} className="relative z-10 overflow-clip">
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_15%_0%,rgba(79,70,229,.28),transparent_70%),radial-gradient(50%_40%_at_90%_10%,rgba(6,182,212,.16),transparent_70%)]" />
          <RewindDial className="absolute left-1/2 top-10 w-[min(68rem,170vw)] -translate-x-1/2 opacity-60 sm:top-4 sm:opacity-90" />
          {/* Fade the dial into the page so it never competes with the playground. */}
          <div className="absolute inset-x-0 top-[38rem] h-[40rem] bg-[linear-gradient(to_bottom,transparent,#050608_55%)]" />
        </div>
        <motion.div style={{ y: heroY, opacity: heroOpacity, scale: heroScale }} className="relative mx-auto flex min-h-[100svh] max-w-5xl flex-col items-center justify-center px-4 pb-24 pt-28 text-center sm:px-6">
          <h1 className="mt-4 text-[clamp(2.6rem,7.2vw,5.6rem)] font-semibold leading-[1.04] tracking-[-0.045em]">
            <span className="sr-only">Agents break things. </span>
            <motion.span
              aria-hidden
              className="-mb-[0.16em] block bg-[linear-gradient(180deg,#fff,rgba(255,255,255,.72))] bg-clip-text pb-[0.16em] text-transparent"
              initial={{ opacity: 0, y: 28, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            >
              Agents break
            </motion.span>
            <motion.span aria-hidden className="block" initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}>
              <WordRotator words={['thermostats.', 'task lists.', 'CRM records.', 'calendars.', 'configs.', 'workflows.']} className="sheen" />
            </motion.span>
            <motion.span
              className="mt-4 block text-[0.5em] font-medium tracking-[-0.03em] text-white/55"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              Rewind puts them back.
            </motion.span>
          </h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, duration: 0.9, ease: [0.16, 1, 0.3, 1] }} className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-white/55 sm:text-lg">
            The execution layer between your agent and its tools. Every write is recorded, the first failure is contained, eligible steps are compensated in reverse, and every
            resource is <span className="text-white">read back and verified</span>. When something can&apos;t be undone, you&apos;re told exactly what.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5, duration: 0.9, ease: [0.16, 1, 0.3, 1] }} className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Magnetic>
            <button
              type="button"
              onClick={tryDemo}
              disabled={busy}
              className="group relative inline-flex h-12 items-center gap-2 overflow-hidden rounded-full bg-white px-6 text-sm font-semibold text-black shadow-[0_0_48px_-6px_rgba(129,140,248,.85)] transition-shadow duration-500 hover:shadow-[0_0_64px_-4px_rgba(103,232,249,.9)] disabled:opacity-60"
            >
              <span className="absolute inset-0 -translate-x-full bg-[linear-gradient(90deg,transparent,rgba(99,102,241,.25),transparent)] transition-transform duration-700 group-hover:translate-x-full" aria-hidden />
              {busy ? <span className="size-4 animate-spin rounded-full border-2 border-black/30 border-t-black" aria-hidden /> : <Launch className="size-4" aria-hidden />}
              {me ? 'Open the live demo' : 'Try the live demo, no signup'}
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
            </button>
            </Magnetic>
            <Magnetic>
            <a href="#playground" className="inline-flex h-12 items-center gap-2 rounded-full border border-white/15 bg-[#0b0c10]/70 px-6 text-sm font-semibold text-white transition-colors hover:border-white/30 hover:bg-white/10">
              Break something first <ChevronDown className="size-4" aria-hidden />
            </a>
            </Magnetic>
          </motion.div>
          <p className="mt-6 text-xs text-white/40">Open source · self-hosted in one command · no LLM in the safety path</p>
          {/* A quiet cue that there is more below: the voice and text box. */}
          <motion.a
            href="#ask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2, duration: 0.8 }}
            className="group absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 text-xs text-white/40 transition-colors hover:text-white/80"
          >
            Or just ask it
            <ChevronDown className="size-4 animate-bounce group-hover:text-cyan-200" aria-hidden />
          </motion.a>
        </motion.div>
      </section>

      {/* Ask: type or say your own request */}
      <section id="ask" className="relative z-10 scroll-mt-20 px-4 pb-8 pt-6 sm:px-6 sm:pt-10">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-cyan-300">Try it with your voice</p>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">Say it. Watch it fail. Watch it rewind.</h2>
          <p className="mx-auto mt-4 max-w-xl text-white/55">
            Ask the house to do something, in your own words. A real agent carries it out through Rewind, the last step fails on purpose, and Rewind puts everything back, then tells
            you what happened.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <AskBox onRun={runRequest} busy={busy} />
        </Reveal>
      </section>

      <section className="relative z-10">

        {/* Playground */}
        <div id="playground" className="relative mx-auto mt-20 max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6">
          <TiltIn>
            <div className="beam rounded-3xl shadow-[0_40px_120px_-40px_rgba(99,102,241,.55)]">
              <Playground />
            </div>
          </TiltIn>
        </div>
      </section>

      {/* Capability marquee */}
      <section className="relative z-10 border-y border-white/5 bg-white/[.015] py-6" aria-label="Examples of declared recovery capabilities">
        <div className="marquee flex w-max gap-3">
          {[...CAPABILITIES, ...CAPABILITIES].map(([label, cap], i) => (
            <span key={i} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 text-xs text-white/70" aria-hidden={i >= CAPABILITIES.length}>
              {label}
              <span className={cx('rounded-full px-1.5 py-px font-mono text-[10px]', cap === 'irreversible' ? 'bg-rose-500/15 text-rose-300' : cap === 'rollback' ? 'bg-indigo-400/15 text-indigo-200' : 'bg-emerald-400/15 text-emerald-300')}>{cap}</span>
            </span>
          ))}
        </div>
      </section>

      {/* Numbers */}
      <section className="relative z-10 mx-auto max-w-6xl px-4 pt-28 sm:px-6" aria-label="Rewind by the numbers">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 md:grid-cols-4">
          {[
            { n: 0, s: '', label: 'LLM calls in the safety path' },
            { n: 100, s: '%', label: 'of undone writes read back' },
            { n: 7, s: '', label: 'recovery outcomes, each named' },
            { n: 11, s: '', label: 'MCP tools, none can approve' },
          ].map((x) => (
            <div key={x.label} className="relative bg-[#07080b] px-6 py-8">
              <p className="bg-[linear-gradient(180deg,#fff,rgba(255,255,255,.55))] bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl">
                <CountUp to={x.n} suffix={x.s} />
              </p>
              <p className="mt-2 text-sm text-white/50">{x.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Manifesto */}
      <section className="relative z-10 mx-auto max-w-5xl px-4 pt-32 sm:px-6">
        <ScrollWords
          className="text-[clamp(1.75rem,4vw,3.25rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-white"
          text="Agents act fast and fail halfway. Most tools hand you a log and an apology. Rewind hands you back the original state, verified, and names anything that could not come back."
        />
      </section>

      {/* Story */}
      <section id="how" className="relative z-10 mx-auto max-w-6xl scroll-mt-24 px-4 py-28 sm:px-6">
        <Reveal className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-indigo-300">How it works</p>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">An apology isn&apos;t a rollback.</h2>
          <p className="mt-4 text-white/60">Four deterministic steps, from the first tool call to the last check. A model can ask; Rewind decides.</p>
        </Reveal>
        <div className="mt-16 grid grid-cols-1 gap-12 lg:grid-cols-2">
          <div className="hidden lg:block">
            <div className="sticky top-32">
              <div className="beam relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0c10] p-8">
                <div className="scan pointer-events-none absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,transparent,rgba(103,232,249,.07),transparent)]" aria-hidden />
                <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,.25),transparent)]" aria-hidden />
                <motion.div key={story.active} initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}>
                    <div className="flex items-center gap-3">
                      <span className="flex size-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#6366f1,#06b6d4)]">
                        <ActiveIcon className="size-6 text-white" aria-hidden />
                      </span>
                      <span className="font-mono text-sm text-white/40">0{story.active + 1} / 04</span>
                    </div>
                    <p className="mt-6 text-3xl font-semibold">{STORY[story.active]!.title}</p>
                    <pre className="mt-6 overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-xs leading-relaxed text-cyan-100/80">{STORY[story.active]!.code}</pre>
                </motion.div>
                <div className="mt-8 flex gap-1.5">
                  {STORY.map((_, i) => (
                    <span key={i} className={cx('h-1 flex-1 rounded-full transition-colors duration-500', i <= story.active ? 'bg-[linear-gradient(90deg,#818cf8,#22d3ee)]' : 'bg-white/10')} />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <ol className="space-y-6 lg:space-y-[28vh] lg:py-[10vh]">
            {STORY.map((s, i) => (
              <li key={s.title} ref={story.bind(i)} data-step={i}>
                <SpotlightCard className={cx('transition-all duration-700 ease-[cubic-bezier(.16,1,.3,1)]', story.active === i ? 'lg:scale-100 lg:opacity-100' : 'lg:scale-[.97] lg:opacity-35')}>
                  <div className="flex items-center gap-3">
                    <s.icon className="size-5 text-indigo-300" aria-hidden />
                    <span className="font-mono text-xs text-white/40">0{i + 1}</span>
                  </div>
                  <p className="mt-4 text-2xl font-semibold">{s.title}</p>
                  <p className="mt-2 leading-relaxed text-white/60">{s.body}</p>
                  <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-[11px] text-cyan-100/70 lg:hidden">{s.code}</pre>
                </SpotlightCard>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* MCP */}
      <section id="mcp" className="relative z-10 scroll-mt-24 border-t border-white/5 py-28">
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1fr_1.15fr]">
          <Reveal>
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-cyan-300">MCP-native</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">One endpoint. Any agent.</h2>
            <p className="mt-4 text-white/60">
              A self-hosted Model Context Protocol server over Streamable HTTP, built on the official SDK. Agents discover registered operations, run them as steps, and ask for
              recovery. The approve button stays with people.
            </p>
            <div className="mt-6 flex items-center gap-2 rounded-xl border border-white/10 bg-black/50 px-3 py-2.5 font-mono text-xs text-white/80">
              <span className="text-white/40">$</span>
              <span className="min-w-0 flex-1 truncate">claude mcp add --transport http rewind http://127.0.0.1:4747/mcp</span>
              <CopyButton value={'claude mcp add --transport http rewind http://127.0.0.1:4747/mcp --header "Authorization: Bearer $REWIND_API_KEY"'} className="text-white/60 hover:bg-white/10 hover:text-white" />
            </div>
            <ul className="mt-6 grid grid-cols-2 gap-2 font-mono text-xs text-white/60">
              {['list_operations', 'create_execution', 'execute_registered_action', 'get_execution_trace', 'request_recovery', 'get_recovery_status'].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-cyan-300" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="float-y">
              <div className="beam rounded-2xl">
                <Terminal />
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Security bento */}
      <section id="security" className="relative z-10 mx-auto max-w-6xl scroll-mt-24 px-4 py-28 sm:px-6">
        <Reveal className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-indigo-300">Built for teams</p>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Safety enforced by the server, not suggested in a prompt.</h2>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3 md:grid-rows-[auto_auto]">
          <Reveal className="md:col-span-2">
            <SpotlightCard className="h-full">
              <ShieldCheck className="size-6 text-indigo-300" aria-hidden />
              <p className="mt-5 text-xl font-semibold">Default-deny policies and human approvals</p>
              <p className="mt-2 max-w-lg text-white/60">Allow, require approval, or prohibit per operation, re-checked at execution time. Irreversible steps can pause for an admin. No MCP tool can approve an action, and the agent's operator can't approve their own.</p>
              <div className="mt-6 flex flex-wrap gap-2 font-mono text-[11px]">
                <span className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-emerald-300">home-sim:* → allow</span>
                <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-amber-300">notify.send_message → approval</span>
                <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-rose-300">security.disarm → prohibit</span>
              </div>
            </SpotlightCard>
          </Reveal>
          <Reveal delay={0.05}>
            <SpotlightCard className="h-full">
              <Fingerprint className="size-6 text-cyan-300" aria-hidden />
              <p className="mt-5 text-xl font-semibold">SSO, 2FA, lockout</p>
              <p className="mt-2 text-white/60">OpenID Connect (Google, Microsoft, Okta, any OIDC), TOTP with recovery codes, and automatic lockout with email alerts.</p>
            </SpotlightCard>
          </Reveal>
          {[
            { icon: UserCheck, title: 'Roles that mean something', body: 'Owner, admin, member, viewer, checked on every API and MCP call.' },
            { icon: FileLock2, title: 'Append-only audit', body: 'The database refuses to rewrite history. Every event hashed and timestamped.' },
            { icon: Webhook, title: 'Signed webhooks', body: 'HMAC-signed events to your on-call stack, SSRF-guarded, with retries.' },
          ].map((f, i) => (
            <Reveal key={f.title} delay={0.05 * i}>
              <SpotlightCard className="h-full">
                <f.icon className="size-6 text-indigo-300" aria-hidden />
                <p className="mt-5 text-lg font-semibold">{f.title}</p>
                <p className="mt-2 text-sm text-white/60">{f.body}</p>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { icon: Lock, label: 'Workspace isolation' },
            { icon: KeyRound, label: 'Hashed keys & tokens' },
            { icon: AgentMark, label: 'No LLM in the safety path' },
            { icon: GitBranch, label: 'Open source, self-hosted' },
          ].map((f) => (
            <div key={f.label} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[.02] px-4 py-3 text-sm text-white/70">
              <f.icon className="size-4 text-white/50" aria-hidden />
              {f.label}
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="relative z-10 mx-auto max-w-3xl scroll-mt-24 px-4 pb-28 sm:px-6">
        <Reveal>
          <h2 className="text-center text-4xl font-semibold tracking-tight">Straight answers</h2>
        </Reveal>
        <div className="mt-10 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[.02]">
          {FAQ.map(([q, a], i) => (
            <div key={q}>
              <button type="button" onClick={() => setOpenFaq(openFaq === i ? null : i)} aria-expanded={openFaq === i} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
                <span className="font-medium">{q}</span>
                <ChevronDown className={cx('size-4 shrink-0 text-white/50 transition-transform', openFaq === i && 'rotate-180')} aria-hidden />
              </button>
              <AnimatePresence initial={false}>
                {openFaq === i && (
                  <motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden px-5 text-sm leading-relaxed text-white/60">
                    <span className="block pb-4">{a}</span>
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 overflow-hidden px-4 pb-24 sm:px-6">
        <Reveal className="beam relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-[#07080b] px-6 py-20 text-center sm:px-12">
          <div className="pointer-events-none absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-[linear-gradient(90deg,transparent,rgba(165,180,252,.9),transparent)]" aria-hidden />
          <RewindDial className="pointer-events-none absolute -bottom-[26rem] left-1/2 w-[46rem] -translate-x-1/2 opacity-60" />
          <RewindMark className="relative mx-auto size-7 text-indigo-200" aria-hidden />
          <h2 className="relative mt-5 text-3xl font-semibold tracking-tight sm:text-5xl">Watch a failure get rewound in under a minute.</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-white/60">A synthetic smart home, a real MCP connection, a deliberately injected failure. No keys, no accounts, no model.</p>
          <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button type="button" onClick={tryDemo} disabled={busy} className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-black transition hover:scale-[1.03]">
              <Launch className="size-4" aria-hidden /> Launch the live demo
            </button>
            <Link to="/signup" className="inline-flex h-12 items-center rounded-full border border-white/20 px-6 text-sm font-semibold text-white hover:bg-white/10">
              Create a workspace
            </Link>
          </div>
        </Reveal>
      </section>

      <footer className="relative z-10 border-t border-white/5">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-xs text-white/40 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo small />
          <p>The demo controls a synthetic home only: no real devices, accounts or data. MIT licensed.</p>
        </div>
      </footer>
    </div>
  );
}
