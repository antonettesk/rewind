/**
 * Redaction applied to every payload before it is persisted, logged or
 * returned through MCP. It is key-based: values under sensitive-looking keys are
 * replaced, long strings are truncated, and deep structures are bounded.
 */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id|ssn|card[-_]?number/i;
const BEARER = /\b(bearer)\s+[a-z0-9._~+/=-]{8,}/gi;
const MAX_STRING = 2_000;
const MAX_DEPTH = 8;
const MAX_KEYS = 100;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const scrubbed = value.replace(BEARER, `$1 ${REDACTED}`);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}… [truncated ${scrubbed.length - MAX_STRING} chars]` : scrubbed;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_KEYS).map((v) => redact(v, depth + 1));
    if (value.length > MAX_KEYS) items.push(`[+${value.length - MAX_KEYS} items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (count++ >= MAX_KEYS) {
      out['…'] = '[key limit]';
      break;
    }
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
