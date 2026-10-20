import { redact } from './domain/redact.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stdout. Every field passes through redaction. */
export function createLogger(minLevel: Level | 'silent' = 'info'): Logger {
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (minLevel === 'silent' || ORDER[level] < ORDER[minLevel]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as Record<string, unknown>) });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
