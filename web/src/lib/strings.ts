/**
 * User-facing labels in one place, so localization can replace this module
 * without touching components.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'accent';

export const EXECUTION_STATUS: Record<string, { label: string; tone: Tone; help: string }> = {
  pending: { label: 'Pending', tone: 'neutral', help: 'Created; no step has run yet.' },
  running: { label: 'Running', tone: 'info', help: 'Steps are executing.' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warn', help: 'A step needs a person to approve it before it runs.' },
  succeeded: { label: 'Succeeded', tone: 'ok', help: 'Every step completed.' },
  failed: { label: 'Failed', tone: 'bad', help: 'A step failed. Recovery has not run or was not needed.' },
  recovering: { label: 'Recovering', tone: 'info', help: 'Compensations are running; results not yet verified.' },
  recovered: { label: 'Recovered · verified', tone: 'ok', help: 'Every effect that needed recovery was compensated and verified by reading the resource back.' },
  partially_recovered: { label: 'Partially recovered', tone: 'warn', help: 'Some effects were restored and verified; others remain.' },
  recovery_failed: { label: 'Recovery failed', tone: 'bad', help: 'Recovery ran but could not establish the original state.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', help: 'Stopped before completion.' },
};

export const ACTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warn' },
  denied: { label: 'Denied by policy', tone: 'bad' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  outcome_unknown: { label: 'Outcome unknown', tone: 'warn' },
  skipped: { label: 'Not run', tone: 'neutral' },
};

export const RECOVERY_OUTCOME: Record<string, { label: string; tone: Tone; help: string }> = {
  not_required: { label: 'Not required', tone: 'neutral', help: 'The step left no effect to reverse.' },
  recovery_verified: { label: 'Recovered · verified', tone: 'ok', help: 'Compensated, then confirmed by reading the resource back.' },
  recovery_pending: { label: 'Recovery pending', tone: 'info', help: 'Compensation started but is not yet verified.' },
  recovery_available: { label: 'Recovery available', tone: 'accent', help: 'A registered compensation exists and has not been run.' },
  recovery_failed: { label: 'Recovery failed', tone: 'bad', help: 'Compensation was attempted but restoration could not be verified.' },
  recovery_unavailable: { label: 'Recovery unavailable', tone: 'bad', help: 'No safe way to reverse this effect. It remains.' },
  manual_review: { label: 'Needs manual review', tone: 'warn', help: 'REWIND cannot safely decide; a person must look.' },
};

export const ATTEMPT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  verified: { label: 'Verified', tone: 'ok' },
  unverified: { label: 'Not verified', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  conflict: { label: 'State conflict', tone: 'warn' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

export const CAPABILITY: Record<string, { label: string; tone: Tone; help: string }> = {
  compensatable: { label: 'Compensatable', tone: 'ok', help: 'A registered compensating operation can restore the previous state.' },
  rollback: { label: 'True rollback', tone: 'ok', help: 'The target system provides transactional rollback.' },
  irreversible: { label: 'Irreversible', tone: 'bad', help: 'Cannot be undone once applied.' },
  none: { label: 'Read-only', tone: 'neutral', help: 'No side effect.' },
};

export const POLICY_DECISION: Record<string, { label: string; tone: Tone }> = {
  allow: { label: 'Allowed', tone: 'ok' },
  require_approval: { label: 'Requires approval', tone: 'warn' },
  deny: { label: 'Denied', tone: 'bad' },
};

/** Human description of an audit event type. */
export const EVENT_LABEL: Record<string, string> = {
  'execution.created': 'Execution created',
  'execution.idempotent_replay': 'Duplicate create ignored (idempotency key)',
  'action.planned': 'Step planned',
  'policy.evaluated': 'Policy evaluated',
  'execution.status_changed': 'Status changed',
  'approval.requested': 'Approval requested',
  'approval.granted': 'Approval granted',
  'approval.rejected': 'Approval rejected',
  'snapshot.captured': 'State captured',
  'action.started': 'Step started',
  'action.retry_scheduled': 'Safe retry scheduled',
  'action.succeeded': 'Step succeeded',
  'action.failed': 'Step failed',
  'action.outcome_unknown': 'Outcome unknown',
  'action.deduplicated': 'Duplicate call deduplicated',
  'execution.halted': 'Forward execution halted',
  'recovery.not_required': 'No recovery needed',
  'recovery.awaiting_request': 'Recovery awaiting request',
  'recovery.requested': 'Recovery requested',
  'recovery.duplicate_ignored': 'Duplicate recovery request ignored',
  'recovery.blocked': 'Recovery blocked',
  'reconciliation.completed': 'Outcome reconciled by read-back',
  'recovery.planned': 'Recovery planned',
  'compensation.started': 'Compensation started',
  'compensation.succeeded': 'Compensation handler returned',
  'compensation.failed': 'Compensation failed',
  'compensation.conflict': 'Compensation skipped: state conflict',
  'compensation.blocked': 'Compensation blocked by dependency',
  'verification.passed': 'Verification passed',
  'verification.failed': 'Verification failed',
  'recovery.completed': 'Recovery completed',
  'system.interrupted': 'Interrupted by restart',
};

export function eventTone(type: string): Tone {
  if (/failed|conflict|unknown|blocked|interrupted|rejected/.test(type)) return type === 'action.outcome_unknown' || type.includes('conflict') || type.includes('blocked') ? 'warn' : 'bad';
  if (/verification.passed|succeeded|granted/.test(type)) return 'ok';
  if (/compensation|recovery|reconciliation/.test(type)) return 'info';
  if (/approval|retry/.test(type)) return 'warn';
  return 'neutral';
}
