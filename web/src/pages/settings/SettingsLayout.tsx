import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router';
import { LoadingRows, PageHeader, cx } from '../../components/ui';
import { useRole } from '../../lib/auth';

const TABS = [
  { to: '/app/settings', label: 'General', end: true },
  { to: '/app/settings/members', label: 'Members' },
  { to: '/app/settings/keys', label: 'API keys', min: 'admin' as const },
  { to: '/app/settings/webhooks', label: 'Webhooks', min: 'admin' as const },
  { to: '/app/settings/connect', label: 'Connect' },
  { to: '/app/settings/account', label: 'Account' },
];

export function SettingsLayout() {
  const { can } = useRole();
  return (
    <>
      <PageHeader title="Settings" description="Your workspace, team, keys, integrations and account." />
      <nav aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((t) => !t.min || can(t.min)).map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors', isActive ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-2 hover:text-fg')
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<LoadingRows rows={4} />}>
        <Outlet />
      </Suspense>
    </>
  );
}

export function RoleNote({ min }: { min: string }) {
  return <p className="rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm text-fg-2">Only workspace {min}s and above can change this. Ask an owner or admin if you need access.</p>;
}
