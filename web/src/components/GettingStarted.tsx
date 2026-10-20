import { Check, X } from './icons';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth';
import { cx } from './ui';

const KEY = 'rewind.gettingStarted.dismissed';

/** Checklist driven by real activation milestones recorded on the server. Hidden once complete or dismissed. */
export function GettingStarted() {
  const { me } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(`${KEY}.${me?.workspace.id}`) === '1';
    } catch {
      return false;
    }
  });
  if (!me || dismissed) return null;
  const m = me.milestones;
  const items = [
    { done: Boolean(m.first_verified_recovery), label: 'Watch a failure get rewound', to: '/app/demo' },
    { done: Boolean(m.first_api_key), label: 'Create an API key', to: '/app/settings/keys' },
    { done: Boolean(m.first_mcp_call), label: 'Connect your agent over MCP', to: '/app/settings/connect' },
    { done: me.user.kind !== 'guest' && Boolean(m.first_invite), label: me.user.kind === 'guest' ? 'Create an account to keep your work' : 'Invite a teammate', to: me.user.kind === 'guest' ? '/app/settings/account' : '/app/settings/members' },
  ];
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <section className="relative mb-6 overflow-hidden rounded-xl border border-border bg-surface p-4" aria-label="Getting started">
      <div className="bg-brand absolute inset-x-0 top-0 h-0.5" style={{ width: `${(done / items.length) * 100}%` }} aria-hidden />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Getting started</p>
          <p className="text-xs text-fg-3">
            {done} of {items.length} done
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss getting started"
          className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(`${KEY}.${me.workspace.id}`, '1');
            } catch {
              /* not persisted */
            }
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((i) => (
          <li key={i.label}>
            <Link to={i.to} className={cx('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors', i.done ? 'border-border text-fg-3' : 'border-border-strong hover:border-accent hover:bg-accent-soft/40')}>
              <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full', i.done ? 'bg-ok text-white' : 'border border-border-strong')}>{i.done && <Check className="size-3" aria-hidden />}</span>
              <span className={i.done ? 'line-through' : ''}>{i.label}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
