/**
 * Error vocabulary shared by the engine, HTTP API and MCP tools.
 * Codes are stable identifiers; messages are for humans.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'CONCURRENCY_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'UNKNOWN_OPERATION'
  | 'RESOURCE_LOCKED'
  | 'RECOVERY_IN_PROGRESS'
  | 'RECOVERY_NOT_ALLOWED'
  | 'LIMIT_EXCEEDED'
  | 'UNAUTHORIZED'
  | 'ACCOUNT_LOCKED'
  | 'FORBIDDEN'
  | 'INTERNAL';

export class DomainError extends Error {
  override readonly name = 'DomainError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'UNKNOWN_OPERATION':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'POLICY_DENIED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_TRANSITION':
    case 'CONCURRENCY_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'RESOURCE_LOCKED':
    case 'RECOVERY_IN_PROGRESS':
    case 'RECOVERY_NOT_ALLOWED':
    case 'APPROVAL_REQUIRED':
      return 409;
    case 'LIMIT_EXCEEDED':
      return 429;
    case 'ACCOUNT_LOCKED':
      return 423;
    default:
      return 500;
  }
}

/**
 * What an adapter knows about whether a failed call changed anything.
 *  - none:    the call definitely did not apply its effect
 *  - applied: the effect applied, but the call still reported an error
 *  - unknown: the adapter cannot tell (timeouts, crashes, unclassified errors)
 */
export type EffectCertainty = 'none' | 'applied' | 'unknown';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  constructor(
    readonly code: string,
    message: string,
    readonly effect: EffectCertainty,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface ClassifiedError {
  code: string;
  message: string;
  effect: EffectCertainty;
  retryable: boolean;
}

/**
 * Conservative classification: anything that is not an explicit AdapterError is
 * treated as an unknown outcome and never retried, because we cannot prove the
 * mutation did not happen.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof AdapterError) {
    return {
      code: error.code,
      message: error.message,
      effect: error.effect,
      // Only a failure that definitely had no effect is safe to retry.
      retryable: error.retryable && error.effect === 'none',
    };
  }
  if (error instanceof TimeoutError) {
    return { code: 'TIMEOUT', message: error.message, effect: 'unknown', retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'UNCLASSIFIED_ERROR', message, effect: 'unknown', retryable: false };
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`Operation did not respond within ${timeoutMs} ms; its outcome is unknown.`);
  }
}
