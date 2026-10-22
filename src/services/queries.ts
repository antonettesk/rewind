/**
 * Read models. Everything the UI, the HTTP API and MCP tools display about an
 * execution is assembled here from persisted records, so every surface tells
 * the same story.
 */
import type { AdapterRegistry } from '../adapters/registry.js';
import { DomainError } from '../domain/errors.js';
import { effectiveLimits } from '../domain/policy.js';
import type { Action, AuditEvent, Execution, RecoveryAttempt, RecoveryRequest, StateSnapshot } from '../domain/records.js';
import { planRecovery, type PlannableAction } from '../domain/recovery-plan.js';
import { RECOVERABLE_EXECUTION_STATUSES, type RecoveryOutcome } from '../domain/status.js';
import { diffObjects, type FieldDiff } from '../domain/util.js';
import type { Repository } from '../persistence/repository.js';

export interface ActionView extends Action {
  operationKey: string;
  operationTitle: string;
  capability: string;
  recoverySummary: string;
  input: unknown;
  result: unknown;
  snapshots: Partial<Record<StateSnapshot['phase'], StateSnapshot>>;
  /** Field-level change the forward action made (before → after), when both were captured. */
  forwardDiff: FieldDiff[] | null;
  recoveryAttempts: RecoveryAttempt[];
  recoveryOutcome: RecoveryOutcome;
  recoveryOutcomeReason: string;
  durationMs: number | null;
}

export interface ExecutionView {
  execution: Execution;
  durationMs: number | null;
  actions: ActionView[];
  recoveryRequests: RecoveryRequest[];
  events: AuditEvent[];
  eventsTruncated: boolean;
  summary: {
    actionCount: number;
    succeeded: number;
    failedAt: number | null;
    recoveryStatus: 'not_needed' | 'not_requested' | 'in_progress' | 'verified' | 'partial' | 'failed';
    verified: number;
    unresolved: { actionId: string; sequence: number; operationKey: string; outcome: RecoveryOutcome; reason: string }[];
    retry: { available: boolean; reason: string };
  };
}

export function msBetween(a: string | null, b: string | null): number | null {
  return a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null;
}

export class Queries {
  constructor(
    private readonly repo: Repository,
    private readonly registry: AdapterRegistry,
  ) {}

  async executionView(workspaceId: string, executionId: string, opts: { maxEvents?: number } = {}): Promise<ExecutionView> {
    const execution = await this.repo.getExecution(workspaceId, executionId);
    if (!execution) throw new DomainError('NOT_FOUND', `Execution ${executionId} not found in this workspace.`);
    const [actions, snapshots, attempts, requests, allEvents, policies] = await Promise.all([
      this.repo.listActions(executionId),
      this.repo.listSnapshots(executionId),
      this.repo.listRecoveryAttempts(executionId),
      this.repo.listRecoveryRequests(executionId),
      this.repo.listAudit(executionId),
      this.repo.listPolicies(workspaceId),
    ]);
    const maxEvents = opts.maxEvents ?? 500;
    const events = allEvents.slice(0, maxEvents);

    const views: ActionView[] = [];
    for (const a of actions) {
      const op = this.registry.resolve(a.adapterId, a.operation);
      const snaps: ActionView['snapshots'] = {};
      for (const s of snapshots.filter((x) => x.actionId === a.id)) snaps[s.phase] ??= s;
      const own = attempts.filter((t) => t.actionId === a.id);
      const { outcome, reason } = deriveOutcome(a, op.recovery.capability, own, execution.status);
      views.push({
        ...a,
        operationKey: `${a.adapterId}:${a.operation}`,
        operationTitle: op.title,
        capability: op.recovery.capability,
        recoverySummary: op.recovery.summary,
        input: a.inputRef ? await this.repo.getPayload(a.inputRef) : null,
        result: a.resultRef ? await this.repo.getPayload(a.resultRef) : null,
        snapshots: snaps,
        forwardDiff: snaps.before && snaps.after ? diffObjects(snaps.before.capturedState.data, snaps.after.capturedState.data) : null,
        recoveryAttempts: own,
        recoveryOutcome: outcome,
        recoveryOutcomeReason: reason,
        durationMs: msBetween(a.startedAt, a.completedAt),
      });
    }

    const failed = actions.find((a) => a.id === execution.failureActionId);
    const unresolved = views
      .filter((v) => !['not_required', 'recovery_verified'].includes(v.recoveryOutcome))
      .map((v) => ({ actionId: v.id, sequence: v.sequence, operationKey: v.operationKey, outcome: v.recoveryOutcome, reason: v.recoveryOutcomeReason }));

    return {
      execution,
      durationMs: msBetween(execution.startedAt ?? execution.createdAt, execution.completedAt),
      actions: views,
      recoveryRequests: requests,
      events,
      eventsTruncated: allEvents.length > events.length,
      summary: {
        actionCount: actions.length,
        succeeded: actions.filter((a) => a.status === 'succeeded').length,
        failedAt: failed?.sequence ?? null,
        recoveryStatus: recoveryStatus(execution, requests, unresolved.length),
        verified: views.filter((v) => v.recoveryOutcome === 'recovery_verified').length,
        unresolved: execution.status === 'succeeded' ? [] : unresolved,
        retry: this.retryAvailability(execution, actions, attempts, requests, policies),
      },
    };
  }

  /**
   * Whether a (further) recovery request would do anything, computed with the
   * same planner the engine uses. The UI shows a retry control only when this
   * says yes.
   */
  private retryAvailability(execution: Execution, actions: Action[], attempts: RecoveryAttempt[], requests: RecoveryRequest[], policies: Awaited<ReturnType<Repository['listPolicies']>>) {
    if (!RECOVERABLE_EXECUTION_STATUSES.includes(execution.status)) {
      return { available: false, reason: `Not available while the execution is ${execution.status}.` };
    }
    const limits = effectiveLimits(policies);
    if (requests.length > 0 && !limits.allowRetry) return { available: false, reason: 'Recovery retries are disabled by policy.' };
    if (requests.length >= limits.maxRecoveryAttempts) return { available: false, reason: `Policy limit of ${limits.maxRecoveryAttempts} recovery requests reached.` };
    const plannable: PlannableAction[] = actions.map((a) => {
      const op = this.registry.resolve(a.adapterId, a.operation);
      return {
        id: a.id,
        sequence: a.sequence,
        status: a.status,
        kind: a.kind,
        capability: op.recovery.capability,
        idempotentCompensation: op.recovery.idempotentCompensation,
        dependsOn: a.dependsOn,
        // Unreconciled unknown outcomes will be reconciled by the request; count them as candidates.
        reconciliation: a.status === 'outcome_unknown' ? (a.reconciliation ?? 'applied') : undefined,
        attempts: attempts.filter((t) => t.actionId === a.id).map((t) => ({ attemptNumber: t.attemptNumber, status: t.status, errorEffect: t.errorEffect })),
      };
    });
    const plan = planRecovery(plannable, { maxAttempts: limits.maxRecoveryAttempts, allowRetry: requests.length === 0 || limits.allowRetry });
    if (plan.compensations.length === 0) {
      const blockers = plan.steps.filter((s) => !['not_required', 'already_verified'].includes(s.decision));
      return { available: false, reason: blockers.length ? `Nothing safe to retry: ${blockers.map((b) => `step ${b.sequence} ${b.decision.replace(/_/g, ' ')}`).join('; ')}.` : 'Nothing left to recover.' };
    }
    return {
      available: true,
      reason: `${requests.length ? 'Retry' : 'Recovery'} would compensate step${plan.compensations.length > 1 ? 's' : ''} ${plan.compensations.map((c) => c.sequence).join(', ')}.`,
    };
  }
}

function recoveryStatus(e: Execution, requests: RecoveryRequest[], unresolved: number): ExecutionView['summary']['recoveryStatus'] {
  if (e.status === 'recovering') return 'in_progress';
  if (e.status === 'recovered') return 'verified';
  if (e.status === 'partially_recovered') return 'partial';
  if (e.status === 'recovery_failed') return 'failed';
  if ((e.status === 'failed' || e.status === 'cancelled') && requests.length === 0) return unresolved > 0 ? 'not_requested' : 'not_needed';
  return 'not_needed';
}

export function deriveOutcome(a: Action, capability: string, attempts: RecoveryAttempt[], executionStatus: string): { outcome: RecoveryOutcome; reason: string } {
  if (a.kind === 'read') return { outcome: 'not_required', reason: 'Read-only operation.' };
  if (['planned', 'awaiting_approval', 'denied', 'skipped'].includes(a.status)) return { outcome: 'not_required', reason: 'Never executed.' };
  if (a.status === 'failed') return { outcome: 'not_required', reason: 'Failed without applying its effect, so there is nothing to reverse.' };
  if (a.status === 'running') return { outcome: 'recovery_pending', reason: 'Still running.' };
  if (a.status === 'outcome_unknown' && a.reconciliation === 'not_applied') {
    return { outcome: 'not_required', reason: 'Outcome was unknown; reading the resource back showed the effect did not apply.' };
  }
  if (a.status === 'outcome_unknown' && a.reconciliation === 'inconclusive') {
    return { outcome: 'manual_review', reason: 'Outcome unknown and the resource state matches neither the original nor the expected result.' };
  }
  if (executionStatus === 'succeeded') return { outcome: 'not_required', reason: 'Execution succeeded; the change is intended.' };
  if (['pending', 'running', 'awaiting_approval'].includes(executionStatus)) {
    return { outcome: 'not_required', reason: 'Execution still in progress; this change is intended so far.' };
  }
  if (capability === 'irreversible') return { outcome: 'recovery_unavailable', reason: 'Declared irreversible. The effect remains and needs a human follow-up.' };
  if (capability !== 'compensatable' && capability !== 'rollback') return { outcome: 'recovery_unavailable', reason: 'No recovery strategy registered.' };
  const last = attempts.at(-1);
  if (!last) {
    if (executionStatus === 'recovering') return { outcome: 'recovery_pending', reason: 'Queued for compensation.' };
    if (a.status === 'outcome_unknown') return { outcome: 'recovery_available', reason: 'Outcome unknown; a recovery request will reconcile it by reading the resource first.' };
    return { outcome: 'recovery_available', reason: 'A registered compensation exists; recovery has not been requested.' };
  }
  switch (last.status) {
    case 'verified':
      return { outcome: 'recovery_verified', reason: `Restored and verified by reading the resource back (attempt ${last.attemptNumber}).` };
    case 'pending':
    case 'running':
      return { outcome: 'recovery_pending', reason: 'Compensation in progress; not yet verified.' };
    case 'conflict':
      return { outcome: 'manual_review', reason: last.errorMessage ?? 'The resource changed after Rewind wrote it.' };
    case 'unverified':
      return { outcome: 'recovery_failed', reason: last.errorMessage ?? 'Compensation ran but verification did not confirm restoration.' };
    default:
      return { outcome: 'recovery_failed', reason: last.errorMessage ?? `Attempt ${last.attemptNumber} ${last.status}.` };
  }
}
