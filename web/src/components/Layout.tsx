import { Activity, Blocks, Check, ChevronsUpDown, FileLock2, LayoutDashboard, LifeBuoy, ListTree, LogOut, Menu, Moon, PlayCircle, RewindMark, Search, Settings, ShieldCheck, Sun, Users, X } from './icons';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { CommandPalette } from './CommandPalette';
import { Logo } from './Logo';
import { cx } from './ui';

const NAV = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/demo', label: 'Agent demo', icon: PlayCircle },
  { to: '/app/executions', label: 'Executions', icon: ListTree },
  { to: '/app/recovery', label: 'Recovery', icon: LifeBuoy },
  { to: '/app/adapters', label: 'Adapters', icon: Blocks },
  { to: '/app/policies', label: 'Policies', icon: ShieldCheck },
  { to: '/app/audit', label: 'Audit log', icon: FileLock2 },
  { to: '/app/settings', label: 'Settings', icon: Settings },
];

function ServerStatus() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => api.health().then(() => alive && setOk(true)).catch(() => alive && setOk(false));
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (ok === null) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-fg-3" role="status">
      <span className={cx('size-1.5 rounded-full', ok ? 'bg-ok' : 'bg-bad')} aria-hidden />
      {ok ? 'All systems healthy' : 'Server unreachable'}
    </div>
  );
}

function UserMenu() {
  const { me, logout, refresh } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!me) return null;
  const initials = me.user.name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-surface-2"
      >
        <span className="bg-brand flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white">{initials || 'G'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.workspace.name}</span>
          <span className="block truncate text-xs text-fg-3">
            {me.user.email ?? 'Guest session'} · <span className="capitalize">{me.workspace.role}</span>
          </span>
        </span>
        <ChevronsUpDown className="size-4 text-fg-3" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl">
          {me.workspaces.length > 1 && (
            <div className="mb-1 border-b border-border pb-1">
              <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Workspaces</p>
              {me.workspaces.map((w) => (
                <button
                  key={w.id}
                  role="menuitem"
                  type="button"
                  onClick={async () => {
                    setOpen(false);
                    if (w.id === me.workspace.id) return;
                    await api.switchWorkspace(w.id);
                    await refresh();
                    nav('/app');
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <span className="text-[11px] capitalize text-fg-3">{w.role}</span>
                  {w.id === me.workspace.id && <Check className="size-3.5 text-accent" aria-hidden />}
                </button>
              ))}
            </div>
          )}
          {me.user.kind === 'guest' && (
            <Link role="menuitem" to="/app/settings/account" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-accent hover:bg-surface-2">
              <RewindMark className="size-4" aria-hidden /> Keep your work: create an account
            </Link>
          )}
          <Link role="menuitem" to="/app/settings/members" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
            <Users className="size-4 text-fg-3" aria-hidden /> Members
          </Link>
          <Link role="menuitem" to="/onboarding" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
            <Activity className="size-4 text-fg-3" aria-hidden /> Getting started
          </Link>
          <Link role="menuitem" to="/app/settings" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
            <Settings className="size-4 text-fg-3" aria-hidden /> Settings
          </Link>
          <Link role="menuitem" to="/app/settings/account" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
            <Activity className="size-4 text-fg-3" aria-hidden /> Account & sessions
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={async () => {
              // Leave the protected area first so the auth guard doesn't redirect to sign-in.
              nav('/');
              await logout();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"
          >
            <LogOut className="size-4 text-fg-3" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [dark, setDark] = useTheme();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const { me } = useAuth();
  const reduceMotion = useReducedMotion();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav = (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) =>
            cx(
              'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
              isActive ? 'font-medium text-fg' : 'text-fg-2 hover:bg-surface-2/70 hover:text-fg',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-surface-2" transition={{ type: 'spring', stiffness: 500, damping: 40 }} aria-hidden>
                  <span className="bg-brand absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full" />
                </motion.span>
              )}
              <n.icon className="relative size-4" aria-hidden />
              <span className="relative">{n.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const searchButton = (
    <button
      type="button"
      onClick={() => setPalette(true)}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1.5 text-sm text-fg-3 hover:text-fg-2"
    >
      <Search className="size-4" aria-hidden />
      <span className="flex-1 text-left">Search…</span>
      <kbd>⌘K</kbd>
    </button>
  );

  const footer = (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <ServerStatus />
        <button type="button" onClick={() => setDark(!dark)} className="rounded-md p-1.5 text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`}>
          {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </button>
      </div>
      <UserMenu />
    </div>
  );

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col justify-between border-r border-border bg-surface px-3 py-4 lg:flex">
        <div className="space-y-5">
          <Link to="/" className="block px-2.5" aria-label="REWIND home">
            <Logo />
          </Link>
          {searchButton}
          {nav}
        </div>
        {footer}
      </aside>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <Logo />
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setPalette(true)} aria-label="Search" className="rounded p-1.5 hover:bg-surface-2">
            <Search className="size-5" aria-hidden />
          </button>
          <button type="button" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} className="rounded p-1.5 hover:bg-surface-2">
            <Menu className="size-5" aria-hidden />
          </button>
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close navigation" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col justify-between bg-surface px-3 py-4 shadow-xl">
            <div className="space-y-5">
              <div className="flex items-center justify-between px-2.5">
                <Logo />
                <button type="button" onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded p-1 hover:bg-surface-2">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              {nav}
            </div>
            {footer}
          </div>
        </div>
      )}
      <main id="main" className="lg:pl-60">
        {me?.user.kind === 'guest' && (
          <div className="border-b border-border bg-accent-soft/60 px-4 py-2 text-center text-xs text-fg-2 sm:px-6">
            You're in a temporary guest workspace.{' '}
            <Link to="/app/settings/account" className="font-medium text-accent hover:underline">
              Create an account
            </Link>{' '}
            to keep it, with all your executions.
          </div>
        )}
        <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <motion.div
            key={loc.pathname}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <Outlet />
          </motion.div>
        </div>
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} onToggleTheme={() => setDark(!dark)} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center py-24 text-center">
      <p className="text-gradient text-6xl font-semibold tracking-tight">404</p>
      <h1 className="mt-4 text-lg font-semibold">Nothing was recorded here</h1>
      <p className="mt-1 text-sm text-fg-2">This page doesn't exist, so there is nothing to rewind.</p>
      <Link to="/" className="mt-5 text-sm font-medium text-accent hover:underline">
        Back to the start
      </Link>
    </div>
  );
}
