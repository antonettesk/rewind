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
        <rect width="32" height="32" rx="8" fill="#0b0c10" />
        <circle cx="16" cy="16" r="11.5" fill="none" stroke="url(#rw-g)" strokeWidth="0.9" strokeDasharray="0.9 1.7" opacity="0.55" />
        <path d="M15.2 10 9.2 16l6 6" stroke="url(#rw-g)" strokeWidth="2.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 10 16 16l6 6" stroke="url(#rw-g)" strokeWidth="2.7" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
      </svg>
      <span className={cx('font-semibold tracking-[0.2em]', small ? 'text-xs' : 'text-sm')}>REWIND</span>
    </span>
  );
}
