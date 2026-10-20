import { ArrowRight, Blocks, CornerDownLeft, LayoutDashboard, LifeBuoy, ListTree, LogOut, Moon, PlayCircle, Search, Settings, ShieldCheck } from './icons';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type ExecutionListItem } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EXECUTION_STATUS } from '../lib/strings';
import { cx } from './ui';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Search;
  run: () => void | Promise<void>;
}

/** ⌘K / Ctrl+K: jump anywhere, search executions by task or ID, run the demo. */
export function CommandPalette({ open, onClose, onToggleTheme }: { open: boolean; onClose: () => void; onToggleTheme: () => void }) {
  const nav = useNavigate();
  const { logout } = useAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<ExecutionListItem[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const go = (to: string) => () => {
    nav(to);
    onClose();
  };
  const commands: Command[] = useMemo(
    () => [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, run: go('/app') },
      { id: 'demo', label: 'Run the agent demo', hint: 'Agent demo', icon: PlayCircle, run: go('/app/demo') },
      { id: 'executions', label: 'Executions', icon: ListTree, run: go('/app/executions') },
      { id: 'attention', label: 'Executions needing attention', icon: ListTree, run: go('/app/executions?f=1') },
      { id: 'recovery', label: 'Recovery center', icon: LifeBuoy, run: go('/app/recovery') },
      { id: 'adapters', label: 'Adapters', icon: Blocks, run: go('/app/adapters') },
      { id: 'policies', label: 'Policies', icon: ShieldCheck, run: go('/app/policies') },
      { id: 'audit', label: 'Audit log', icon: ShieldCheck, run: go('/app/audit') },
      { id: 'settings', label: 'Settings', icon: Settings, run: go('/app/settings') },
      { id: 'members', label: 'Members & invitations', icon: Settings, run: go('/app/settings/members') },
      { id: 'keys', label: 'API keys', icon: Settings, run: go('/app/settings/keys') },
      { id: 'webhooks', label: 'Webhooks', icon: Settings, run: go('/app/settings/webhooks') },
      { id: 'connect', label: 'Connect an MCP client', icon: Settings, run: go('/app/settings/connect') },
      { id: 'account', label: 'Account, password & sessions', icon: Settings, run: go('/app/settings/account') },
      { id: 'theme', label: 'Toggle theme', icon: Moon, run: () => { onToggleTheme(); onClose(); } },
      { id: 'logout', label: 'Sign out', icon: LogOut, run: async () => { onClose(); nav('/'); await logout(); } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    setTimeout(() => input.current?.focus(), 10);
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.executions({ search: q.trim(), limit: 5 }).then((r) => setResults(r.items)).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, open]);

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const items: Command[] = [
    ...filtered,
    ...results.map((e) => ({ id: e.id, label: e.taskDescription, hint: `${EXECUTION_STATUS[e.status]?.label ?? e.status} · ${e.id}`, icon: ArrowRight, run: go(`/app/executions/${e.id}`) })),
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="size-4 text-fg-3" aria-hidden />
              <input
                ref={input}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose();
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, items.length - 1));
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  }
                  if (e.key === 'Enter') void items[active]?.run();
                }}
                placeholder="Jump to a page or search executions…"
                aria-label="Search commands and executions"
                aria-activedescendant={items[active] ? `cmd-${items[active]!.id}` : undefined}
                className="h-12 flex-1 bg-transparent text-sm outline-none"
              />
              <kbd>esc</kbd>
            </div>
            <ul role="listbox" className="max-h-80 overflow-auto p-2">
              {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-fg-3">No matches</li>}
              {items.map((c, i) => (
                <li
                  key={c.id}
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void c.run()}
                  className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm', i === active ? 'bg-surface-2' : '')}
                >
                  <c.icon className="size-4 shrink-0 text-fg-3" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="hidden max-w-[45%] truncate text-xs text-fg-3 sm:block">{c.hint}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 text-fg-3" aria-hidden />}
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
