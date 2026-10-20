/** Locale-aware formatting. Domain data stays in ISO-8601 UTC; only display is localized. */
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const number = new Intl.NumberFormat();

export const fmtDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '—');
export const fmtTime = (iso: string | null | undefined) => (iso ? time.format(new Date(iso)) : '—');
export const fmtNumber = (n: number) => number.format(n);

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return relative.format(s, 'second');
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86400), 'day');
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id);
