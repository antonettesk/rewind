import { cx } from './ui';

export function Logo({ small }: { small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" className={small ? 'size-5' : 'size-6'} aria-hidden>
        <defs>
          <linearGradient id="rw-g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--brand-a)" />
            <stop offset="1" stopColor="var(--brand-b)" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" className="fill-fg" />
        <path d="M18.5 9.5 12 16l6.5 6.5" stroke="url(#rw-g)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22.5 9.5v13" stroke="url(#rw-g)" strokeWidth="3.2" strokeLinecap="round" opacity="0.55" />
      </svg>
      <span className={cx('font-semibold tracking-[0.2em]', small ? 'text-xs' : 'text-sm')}>REWIND</span>
    </span>
  );
}
