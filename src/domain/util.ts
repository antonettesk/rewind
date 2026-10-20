import { createHash, randomBytes } from 'node:crypto';

export type IdPrefix = 'exe' | 'act' | 'snp' | 'rec' | 'pol' | 'evt' | 'pay' | 'ws' | 'usr' | 'key';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic JSON: object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Field-level differences between two flat-ish JSON objects (dot paths). */
export interface FieldDiff {
  path: string;
  expected: unknown;
  observed: unknown;
}

export function diffObjects(expected: unknown, observed: unknown, path = ''): FieldDiff[] {
  if (deepEqual(expected, observed)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(expected) && isObj(observed)) {
    const e = expected as Record<string, unknown>;
    const o = observed as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(e), ...Object.keys(o)])].sort();
    return keys.flatMap((k) => diffObjects(e[k], o[k], path ? `${path}.${k}` : k));
  }
  return [{ path: path || '(root)', expected, observed }];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
