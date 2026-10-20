/**
 * Execution, action and recovery state machines.
 *
 * Every status change in the engine goes through `assertTransition`. An illegal
 * transition throws before any write happens, so a bug can never leave an
 * execution in a state the model does not define.
 */
import { DomainError } from './errors.js';

export const EXECUTION_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'recovering',
  'recovered',
  'partially_recovered',
  'recovery_failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * `recovered` is an addition to the brief's minimum set: it means every effect
 * that needed recovery was compensated *and* verified by reading the resource
 * back. Without it, "fully verified" and "partially verified" would collapse.
 */
const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  pending: ['running', 'awaiting_approval', 'cancelled'],
  running: ['running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'cancelled', 'failed'],
  succeeded: [],
  failed: ['recovering'],
  cancelled: ['recovering'],
  recovering: ['recovered', 'partially_recovered', 'recovery_failed'],
  recovered: [],
  partially_recovered: ['recovering'],
  recovery_failed: ['recovering'],
};

export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = ['succeeded', 'recovered'];
/** Statuses in which forward actions may still be appended. */
export const OPEN_EXECUTION_STATUSES: readonly ExecutionStatus[] = ['pending', 'running'];
/** Statuses from which a recovery request is legal. */
export const RECOVERABLE_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'failed',
  'cancelled',
  'partially_recovered',
  'recovery_failed',
];

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `Execution cannot move from "${from}" to "${to}".`, { from, to });
  }
}

export const ACTION_STATUSES = [
  'planned',
  'awaiting_approval',
  'denied',
  'running',
  'succeeded',
  'failed',
  'outcome_unknown',
  'skipped',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  planned: ['running', 'awaiting_approval', 'denied', 'skipped'],
  awaiting_approval: ['planned', 'denied', 'skipped'],
  denied: [],
  running: ['succeeded', 'failed', 'outcome_unknown'],
  succeeded: [],
  failed: [],
  outcome_unknown: [],
  skipped: [],
};

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
  if (!ACTION_TRANSITIONS[from].includes(to)) {
    throw new DomainError('INVALID_TRANSITION', `Action cannot move from "${from}" to "${to}".`, { from, to });
  }
}

/**
 * Recovery attempt status. `verified` is the only status that means the
 * resource was read back and matched its captured original state.
 */
export const RECOVERY_STATUSES = ['pending', 'running', 'verified', 'unverified', 'failed', 'conflict', 'interrupted'] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

/**
 * Per-action recovery outcome, as shown to people. Derived, never stored, so it
 * cannot drift from the underlying attempts.
 */
export type RecoveryOutcome =
  | 'not_required' // the action had no effect (read, or failed before applying)
  | 'recovery_verified'
  | 'recovery_pending'
  | 'recovery_available' // compensatable, not yet attempted (automatic recovery off)
  | 'recovery_failed'
  | 'recovery_unavailable' // no registered strategy or irreversible
  | 'manual_review'; // outcome unknown and reconciliation inconclusive, or state conflict
