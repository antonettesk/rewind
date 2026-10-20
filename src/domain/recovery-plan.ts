/**
 * Recovery planning: pure, deterministic, no I/O. Given what is recorded about
 * an execution's actions, decide which ones get a compensation and in what
 * order. The engine executes this plan; it never improvises one.
 */
import type { RecoveryCapability, OperationKind } from '../adapters/types.js';
import type { EffectCertainty } from './errors.js';
import type { ActionStatus, RecoveryStatus } from './status.js';

export interface PlannableAction {
  id: string;
  sequence: number;
  status: ActionStatus;
  kind: OperationKind;
  capability: RecoveryCapability;
  idempotentCompensation: boolean;
  /**
   * Sequence numbers this action depends on. `null` means "depends on the
   * previous action" (the safe default); `[]` declares it independent.
   */
  dependsOn: number[] | null;
  /** For outcome_unknown actions: what reading the resource back showed. */
  reconciliation?: 'applied' | 'not_applied' | 'inconclusive';
  attempts: { attemptNumber: number; status: RecoveryStatus; errorEffect: EffectCertainty | null }[];
}

export type StepDecision =
  | 'compensate'
  | 'not_required'
  | 'unavailable'
  | 'manual_review'
  | 'already_verified'
  | 'retry_not_safe'
  | 'attempts_exhausted';

export interface PlannedStep {
  actionId: string;
  sequence: number;
  decision: StepDecision;
  reason: string;
  attemptNumber: number;
}

export interface RecoveryPlan {
  /** Compensations to run, already in reverse dependency order. */
  compensations: PlannedStep[];
  /** Every action's decision, including the ones that need nothing. */
  steps: PlannedStep[];
}

export function planRecovery(actions: PlannableAction[], opts: { maxAttempts: number; allowRetry: boolean }): RecoveryPlan {
  const steps = actions.map((a) => decide(a, opts));
  const bySeq = new Map(steps.map((s) => [s.sequence, s]));
  const order = reverseDependencyOrder(actions);
  const compensations = order.map((seq) => bySeq.get(seq)!).filter((s) => s.decision === 'compensate');
  return { compensations, steps: [...steps].sort((a, b) => a.sequence - b.sequence) };
}

function decide(a: PlannableAction, opts: { maxAttempts: number; allowRetry: boolean }): PlannedStep {
  const base = { actionId: a.id, sequence: a.sequence, attemptNumber: a.attempts.length + 1 };
  const step = (decision: StepDecision, reason: string): PlannedStep => ({ ...base, decision, reason });

  if (a.kind === 'read') return step('not_required', 'Read operations have no side effect.');
  if (['planned', 'awaiting_approval', 'denied', 'skipped'].includes(a.status)) {
    return step('not_required', 'The action never ran.');
  }
  if (a.status === 'failed') return step('not_required', 'The adapter reported the action failed without applying its effect.');
  if (a.status === 'running') return step('manual_review', 'The action is still marked running; its outcome must be reconciled first.');

  let applied = a.status === 'succeeded';
  if (a.status === 'outcome_unknown') {
    if (a.reconciliation === 'not_applied') return step('not_required', 'Reconciliation read the resource back: the effect did not apply.');
    if (a.reconciliation !== 'applied') {
      return step('manual_review', 'The outcome is unknown and reading the resource back could not establish whether the effect applied.');
    }
    applied = true;
  }
  if (!applied) return step('not_required', 'No effect to recover.');

  if (a.capability === 'irreversible') return step('unavailable', 'The operation is declared irreversible. Its effect remains.');
  if (a.capability !== 'compensatable' && a.capability !== 'rollback') {
    return step('unavailable', 'No recovery strategy is registered for this operation.');
  }

  const last = a.attempts.at(-1);
  if (!last) return step('compensate', 'Effect applied and a registered compensation exists.');
  if (last.status === 'verified') return step('already_verified', 'An earlier recovery attempt was verified.');
  if (last.status === 'conflict') {
    return step('manual_review', 'The resource changed after REWIND touched it. Compensating would overwrite someone else\'s change.');
  }
  if (!opts.allowRetry) return step('retry_not_safe', 'Recovery retries are disabled by policy.');
  if (a.attempts.length >= opts.maxAttempts) return step('attempts_exhausted', `Reached the policy limit of ${opts.maxAttempts} recovery attempts.`);
  const priorHadNoEffect = last.status === 'failed' && last.errorEffect === 'none';
  if (!priorHadNoEffect && !a.idempotentCompensation) {
    return step('retry_not_safe', 'The previous attempt may have partially applied and this compensation is not declared idempotent.');
  }
  return step('compensate', `Retrying: previous attempt ${last.status}.`);
}

/**
 * Topological order (dependencies first, ties broken by sequence), reversed.
 * Undo happens last-in, first-out across dependency edges.
 */
export function reverseDependencyOrder(actions: Pick<PlannableAction, 'sequence' | 'dependsOn'>[]): number[] {
  const deps = dependencyMap(actions);
  const seqs = [...deps.keys()].sort((x, y) => x - y);
  const order: number[] = [];
  const done = new Set<number>();
  // Dependencies only point backwards (d < sequence), so cycles cannot occur; the guard is defensive.
  const visiting = new Set<number>();
  const visit = (s: number) => {
    if (done.has(s)) return;
    if (visiting.has(s)) throw new Error(`Dependency cycle involving action ${s}`);
    visiting.add(s);
    for (const d of [...(deps.get(s) ?? [])].sort((x, y) => x - y)) visit(d);
    visiting.delete(s);
    done.add(s);
    order.push(s);
  };
  seqs.forEach(visit);
  return order.reverse();
}

function dependencyMap(actions: Pick<PlannableAction, 'sequence' | 'dependsOn'>[]): Map<number, number[]> {
  const seqs = actions.map((a) => a.sequence).sort((x, y) => x - y);
  const known = new Set(seqs);
  const deps = new Map<number, number[]>();
  for (const a of actions) {
    const prev = seqs.filter((s) => s < a.sequence).at(-1);
    deps.set(a.sequence, a.dependsOn === null ? (prev === undefined ? [] : [prev]) : a.dependsOn.filter((d) => known.has(d) && d < a.sequence));
  }
  return deps;
}

/**
 * Everything `sequence` transitively depends on. If compensating an action
 * fails, these must not be compensated: the surviving effect may rely on them.
 */
export function transitiveDependencies(actions: Pick<PlannableAction, 'sequence' | 'dependsOn'>[], sequence: number): Set<number> {
  const deps = dependencyMap(actions);
  const out = new Set<number>();
  const stack = [...(deps.get(sequence) ?? [])];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    stack.push(...(deps.get(s) ?? []));
  }
  return out;
}

/** Roll up per-action decisions and attempt results into the execution outcome. */
export function summarizeRecovery(
  steps: { decision: StepDecision; finalStatus?: RecoveryStatus }[],
): 'recovered' | 'partially_recovered' | 'recovery_failed' {
  const needed = steps.filter((s) => s.decision !== 'not_required');
  const verified = needed.filter((s) => s.decision === 'already_verified' || s.finalStatus === 'verified');
  if (verified.length === needed.length) return 'recovered';
  return verified.length > 0 ? 'partially_recovered' : 'recovery_failed';
}
