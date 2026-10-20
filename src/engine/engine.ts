/**
 * The REWIND execution engine.
 *
 * Forward path: policy check → lock → capture state → execute (with timeout
 * and bounded, safe retries) → capture state → record. The first failure halts
 * forward progress and, if policy allows, starts recovery.
 *
 * Recovery path (see recover()): reconcile unknown outcomes by reading the
 * resource back → plan deterministically → compensate in reverse dependency
 * order with optimistic concurrency checks → verify by reading back → report
 * exactly what was and was not restored.
 *
 * Nothing in this file consults an LLM. Every safety decision is a function of
 * persisted records, registered capability declarations and policy rows.
 */
import { EventEmitter } from 'node:events';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { OperationDefinition, ResourceState } from '../adapters/types.js';
import { classifyError, DomainError, type ClassifiedError } from '../domain/errors.js';
import { effectiveLimits, evaluateActionPolicy, type ActionPolicyResult } from '../domain/policy.js';
import type { Action, Actor, Execution, RecoveryAttempt, RecoveryRequest, VerificationResult } from '../domain/records.js';
import { planRecovery, summarizeRecovery, transitiveDependencies, type PlannableAction } from '../domain/recovery-plan.js';
import { OPEN_EXECUTION_STATUSES, RECOVERABLE_EXECUTION_STATUSES, type ExecutionStatus, type RecoveryStatus } from '../domain/status.js';
import { canonicalJson, deepEqual, diffObjects, newId, nowIso, sha256 } from '../domain/util.js';
import type { Repository } from '../persistence/repository.js';
import type { Logger } from '../logger.js';
import { KeyedMutex, withTimeout } from './timeout.js';

export interface CallContext {
  workspaceId: string;
  actor: Actor;
}

export interface StepInput {
  adapterId: string;
  operation: string;
  input?: unknown;
  /** Sequence numbers (1-based) of earlier steps this step depends on. Omit for "the previous step". */
  dependsOn?: number[];
  dedupeKey?: string;
}

export interface CreateExecutionInput {
  taskDescription: string;
  idempotencyKey?: string;
  plan?: StepInput[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface EngineEvent {
  workspaceId: string;
  executionId: string;
  eventType: string;
  seq: number;
  actorType: Actor['type'];
  payload: Record<string, unknown>;
}

export class Engine {
  readonly events = new EventEmitter();
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly repo: Repository,
    private readonly registry: AdapterRegistry,
    private readonly log: Logger,
    private readonly environment: string,
  ) {
    this.events.setMaxListeners(200);
  }

  // ───────────────────────────── Creation ─────────────────────────────

  async createExecution(ctx: CallContext, req: CreateExecutionInput): Promise<{ execution: Execution; created: boolean }> {
    const plan = req.plan ?? [];
    const limits = effectiveLimits(await this.repo.listPolicies(ctx.workspaceId));
    if (plan.length > limits.maxActionsPerExecution) {
      throw new DomainError('LIMIT_EXCEEDED', `Plan has ${plan.length} steps; policy allows at most ${limits.maxActionsPerExecution}.`);
    }
    // Resolve and validate every step before persisting anything.
    const resolved = plan.map((step, i) => {
      const op = this.registry.resolve(step.adapterId, step.operation);
      const input = this.registry.parseInput(op, step.input);
      for (const d of step.dependsOn ?? []) {
        if (!Number.isInteger(d) || d < 1 || d > i) throw new DomainError('VALIDATION_FAILED', `Step ${i + 1} can only depend on earlier steps (got ${d}).`);
      }
      return { step, op, input };
    });

    const requestHash = sha256(canonicalJson({ taskDescription: req.taskDescription, plan: resolved.map((r) => ({ ...r.step, input: r.input })) }));
    const { execution, created } = await this.repo.createExecution({
      id: newId('exe'),
      workspaceId: ctx.workspaceId,
      idempotencyKey: req.idempotencyKey ?? newId('exe'),
      requestHash,
      taskDescription: req.taskDescription,
      source: req.source ?? ctx.actor.type,
      actor: ctx.actor,
      environment: this.environment,
      // "plan": steps declared up front and advanced by runPlan. "agent": the caller appends steps one at a time.
      metadata: { ...(req.metadata ?? {}), mode: plan.length ? 'plan' : 'agent' },
    });
    if (!created) {
      await this.audit(ctx, execution.id, 'execution.idempotent_replay', { idempotencyKey: execution.idempotencyKey });
      return { execution, created };
    }
    await this.audit(ctx, execution.id, 'execution.created', {
      taskDescription: execution.taskDescription,
      plannedSteps: plan.length,
      environment: this.environment,
    });
    const policies = await this.repo.listPolicies(ctx.workspaceId);
    for (const [i, { step, op, input }] of resolved.entries()) {
      const key = `${step.adapterId}:${op.name}`;
      const policy = evaluateActionPolicy(policies, key, op.kind);
      const ref = op.resource(input);
      const action = await this.repo.insertAction({
        executionId: execution.id,
        sequence: i + 1,
        adapterId: step.adapterId,
        operation: op.name,
        kind: op.kind,
        status: 'planned',
        dependsOn: step.dependsOn ?? null,
        dedupeKey: step.dedupeKey ?? null,
        resourceType: ref.type,
        resourceId: ref.id,
        inputRef: await this.repo.putPayload(input),
        resultRef: null,
        policy,
        forwardAttempts: 0,
        reconciliation: null,
        errorCode: null,
        errorMessage: null,
        errorEffect: null,
        approvedBy: null,
        startedAt: null,
        completedAt: null,
      });
      await this.audit(ctx, execution.id, 'action.planned', { actionId: action.id, sequence: action.sequence, operation: key, capability: op.recovery.capability });
      await this.audit(ctx, execution.id, 'policy.evaluated', { actionId: action.id, operation: key, decision: policy.decision, reason: policy.reason, matched: policy.matched });
    }
    return { execution: (await this.repo.getExecution(ctx.workspaceId, execution.id))!, created };
  }

  // ───────────────────────────── Forward path ─────────────────────────────

  /** Run every remaining planned step in order. Stops at approval gates and failures. */
  async runPlan(ctx: CallContext, executionId: string): Promise<Execution> {
    return this.mutex.run(executionId, async () => {
      let exe = await this.mustGet(ctx, executionId);
      if (!['pending', 'running', 'awaiting_approval'].includes(exe.status)) {
        throw new DomainError('INVALID_TRANSITION', `Execution is ${exe.status}; there is nothing to run.`);
      }
      for (;;) {
        const actions = await this.repo.listActions(executionId);
        const next = actions.find((a) => a.status === 'planned' || a.status === 'awaiting_approval');
        if (!next) break;
        if (next.status === 'awaiting_approval') return this.mustGet(ctx, executionId);
        const outcome = await this.runAction(ctx, executionId, next);
        if (outcome !== 'succeeded') return this.mustGet(ctx, executionId);
      }
      exe = await this.mustGet(ctx, executionId);
      // An agent-driven execution stays open after an approved step; the agent decides when it is complete.
      if ((exe.status === 'running' || exe.status === 'pending') && exe.metadata.mode !== 'agent') exe = await this.finish(ctx, exe);
      return exe;
    });
  }

  /**
   * Agent-driven path: append one step to an open execution and run it now.
   * A repeated call with the same dedupeKey returns the recorded action
   * instead of executing the mutation again.
   */
  async executeAction(ctx: CallContext, executionId: string, step: StepInput): Promise<{ execution: Execution; action: Action; deduplicated: boolean }> {
    return this.mutex.run(executionId, async () => {
      const exe = await this.mustGet(ctx, executionId);
      const op = this.registry.resolve(step.adapterId, step.operation);
      const input = this.registry.parseInput(op, step.input);
      const actions = await this.repo.listActions(executionId);
      if (step.dedupeKey) {
        const existing = actions.find((a) => a.dedupeKey === step.dedupeKey);
        if (existing) {
          await this.audit(ctx, executionId, 'action.deduplicated', { actionId: existing.id, dedupeKey: step.dedupeKey });
          return { execution: exe, action: existing, deduplicated: true };
        }
      }
      if (!OPEN_EXECUTION_STATUSES.includes(exe.status)) {
        throw new DomainError('INVALID_TRANSITION', `Execution is ${exe.status}; no further actions may run.`, { status: exe.status });
      }
      if (exe.metadata.mode === 'plan') {
        throw new DomainError('INVALID_TRANSITION', 'This execution has a pre-declared plan. Use run_execution to advance it.');
      }
      if (actions.some((a) => a.status === 'awaiting_approval')) {
        throw new DomainError('APPROVAL_REQUIRED', 'A step is waiting for human approval in the REWIND console.');
      }
      const limits = effectiveLimits(await this.repo.listPolicies(ctx.workspaceId));
      if (actions.length >= limits.maxActionsPerExecution) {
        throw new DomainError('LIMIT_EXCEEDED', `Policy allows at most ${limits.maxActionsPerExecution} actions per execution.`);
      }
      const key = `${step.adapterId}:${op.name}`;
      const policy = evaluateActionPolicy(await this.repo.listPolicies(ctx.workspaceId), key, op.kind);
      const ref = op.resource(input);
      const sequence = (actions.at(-1)?.sequence ?? 0) + 1;
      for (const d of step.dependsOn ?? []) {
        if (!actions.some((a) => a.sequence === d)) throw new DomainError('VALIDATION_FAILED', `dependsOn references unknown step ${d}.`);
      }
      const action = await this.repo.insertAction({
        executionId,
        sequence,
        adapterId: step.adapterId,
        operation: op.name,
        kind: op.kind,
        status: 'planned',
        dependsOn: step.dependsOn ?? null,
        dedupeKey: step.dedupeKey ?? null,
        resourceType: ref.type,
        resourceId: ref.id,
        inputRef: await this.repo.putPayload(input),
        resultRef: null,
        policy,
        forwardAttempts: 0,
        reconciliation: null,
        errorCode: null,
        errorMessage: null,
        errorEffect: null,
        approvedBy: null,
        startedAt: null,
        completedAt: null,
      });
      await this.audit(ctx, executionId, 'action.planned', { actionId: action.id, sequence, operation: key, capability: op.recovery.capability });
      await this.audit(ctx, executionId, 'policy.evaluated', { actionId: action.id, operation: key, decision: policy.decision, reason: policy.reason, matched: policy.matched });
      await this.runAction(ctx, executionId, action);
      return { execution: await this.mustGet(ctx, executionId), action: (await this.repo.getAction(action.id))!, deduplicated: false };
    });
  }

  /** Mark an agent-driven execution complete. Fails if any step did not succeed. */
  async completeExecution(ctx: CallContext, executionId: string): Promise<Execution> {
    return this.mutex.run(executionId, async () => {
      const exe = await this.mustGet(ctx, executionId);
      if (!OPEN_EXECUTION_STATUSES.includes(exe.status)) throw new DomainError('INVALID_TRANSITION', `Execution is ${exe.status}.`);
      const actions = await this.repo.listActions(executionId);
      if (actions.some((a) => a.status === 'planned' || a.status === 'awaiting_approval')) {
        throw new DomainError('INVALID_TRANSITION', 'Planned steps remain. Run or cancel them first.');
      }
      return this.finish(ctx, exe);
    });
  }

  /** Human approval of a gated step. Not exposed over MCP: an agent cannot approve its own action. */
  async approveAction(ctx: CallContext, executionId: string, actionId: string): Promise<Execution> {
    await this.mutex.run(executionId, async () => {
      const exe = await this.mustGet(ctx, executionId);
      const action = await this.mustGetAction(executionId, actionId);
      if (exe.status !== 'awaiting_approval' || action.status !== 'awaiting_approval') {
        throw new DomainError('INVALID_TRANSITION', 'This action is not waiting for approval.');
      }
      await this.repo.updateAction(actionId, 'planned', { approvedBy: ctx.actor.label });
      await this.audit(ctx, executionId, 'approval.granted', { actionId, approvedBy: ctx.actor.label });
      await this.repo.transitionExecution(exe.id, exe.version, 'running');
    });
    return this.runPlan(ctx, executionId);
  }

  async rejectAction(ctx: CallContext, executionId: string, actionId: string, reason: string): Promise<Execution> {
    const exe = await this.mutex.run(executionId, async () => {
      const exe = await this.mustGet(ctx, executionId);
      const action = await this.mustGetAction(executionId, actionId);
      if (exe.status !== 'awaiting_approval' || action.status !== 'awaiting_approval') {
        throw new DomainError('INVALID_TRANSITION', 'This action is not waiting for approval.');
      }
      await this.repo.updateAction(actionId, 'denied', { errorCode: 'APPROVAL_REJECTED', errorMessage: reason, completedAt: nowIso() });
      await this.skipRemaining(executionId);
      await this.audit(ctx, executionId, 'approval.rejected', { actionId, reason });
      return this.setStatus(ctx, exe, 'cancelled', { failureReason: `Approval rejected: ${reason}`, failureActionId: actionId, completedAt: nowIso() });
    });
    return this.afterHalt(ctx, exe);
  }

  async cancelExecution(ctx: CallContext, executionId: string, reason: string): Promise<Execution> {
    const exe = await this.mutex.run(executionId, async () => {
      const exe = await this.mustGet(ctx, executionId);
      if (!['pending', 'running', 'awaiting_approval'].includes(exe.status)) throw new DomainError('INVALID_TRANSITION', `Execution is ${exe.status}.`);
      await this.skipRemaining(executionId);
      return this.setStatus(ctx, exe, 'cancelled', { failureReason: reason, completedAt: nowIso() });
    });
    return this.afterHalt(ctx, exe);
  }

  private async finish(ctx: CallContext, exe: Execution): Promise<Execution> {
    if (exe.status === 'pending') exe = await this.setStatus(ctx, exe, 'running', { startedAt: nowIso() });
    const done = await this.setStatus(ctx, exe, 'succeeded', { completedAt: nowIso() });
    await this.releaseLocks(ctx, exe.id);
    return done;
  }

  /** Returns the action's final status. */
  private async runAction(ctx: CallContext, executionId: string, action: Action): Promise<Action['status']> {
    const op = this.registry.resolve(action.adapterId, action.operation);
    const key = `${action.adapterId}:${op.name}`;
    let exe = await this.mustGet(ctx, executionId);

    // Policy is re-evaluated at execution time: rules may have changed since planning.
    const policy = evaluateActionPolicy(await this.repo.listPolicies(ctx.workspaceId), key, op.kind);
    if (!deepEqual(policy, action.policy)) {
      await this.audit(ctx, executionId, 'policy.evaluated', { actionId: action.id, operation: key, decision: policy.decision, reason: policy.reason, matched: policy.matched, reEvaluated: true });
    }
    if (policy.decision === 'deny') {
      await this.repo.updateAction(action.id, 'denied', { errorCode: 'POLICY_DENIED', errorMessage: policy.reason, completedAt: nowIso() });
      await this.skipRemaining(executionId);
      if (exe.status === 'pending') exe = await this.setStatus(ctx, exe, 'running', { startedAt: nowIso() });
      exe = await this.setStatus(ctx, exe, 'failed', { failureReason: `Policy denied ${key}: ${policy.reason}`, failureActionId: action.id, completedAt: nowIso() });
      await this.afterHalt(ctx, exe);
      return 'denied';
    }
    if (policy.decision === 'require_approval' && !action.approvedBy) {
      await this.repo.updateAction(action.id, 'awaiting_approval', {});
      await this.audit(ctx, executionId, 'approval.requested', { actionId: action.id, operation: key, reason: policy.reason });
      await this.setStatus(ctx, exe, 'awaiting_approval');
      return 'awaiting_approval';
    }
    if (exe.status === 'pending') exe = await this.setStatus(ctx, exe, 'running', { startedAt: nowIso() });

    const input = action.inputRef ? await this.repo.getPayload(action.inputRef) : {};
    const ref = { type: action.resourceType, id: action.resourceId };

    // Mutations take a lease on their resource for the life of the execution's active phases.
    if (op.kind === 'mutation') {
      try {
        await this.repo.acquireLocks(ctx.workspaceId, executionId, [`${action.adapterId}:${ref.type}/${ref.id}`]);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return this.failAction(ctx, executionId, action, { code: error.code, message: error.message, effect: 'none', retryable: false });
      }
    }

    // Capture state before the mutation. If we cannot read it, we do not write it.
    let before: ResourceState | null = null;
    if (op.kind === 'mutation') {
      try {
        before = await withTimeout(op.timeoutMs, (signal) => op.read(ref, { workspaceId: ctx.workspaceId, signal }));
        await this.recordSnapshot(ctx, executionId, action.id, 'before', ref, before);
      } catch (error) {
        const c = classifyError(error);
        return this.failAction(ctx, executionId, action, { ...c, code: `SNAPSHOT_FAILED:${c.code}`, effect: 'none', retryable: false });
      }
    }

    await this.repo.updateAction(action.id, 'running', { startedAt: nowIso() });
    await this.audit(ctx, executionId, 'action.started', { actionId: action.id, sequence: action.sequence, operation: key });

    const { maxForwardRetries } = effectiveLimits(await this.repo.listPolicies(ctx.workspaceId));
    for (let attempt = 1; ; attempt++) {
      await this.repo.patchAction(action.id, { forwardAttempts: attempt });
      try {
        const result = await withTimeout(op.timeoutMs, (signal) => op.execute(input, { workspaceId: ctx.workspaceId, executionId, actionId: action.id, signal }));
        const resultRef = await this.repo.putPayload(result);
        if (op.kind === 'mutation') {
          const after = await withTimeout(op.timeoutMs, (signal) => op.read(ref, { workspaceId: ctx.workspaceId, signal })).catch(() => null);
          if (after) await this.recordSnapshot(ctx, executionId, action.id, 'after', ref, after);
        }
        await this.repo.updateAction(action.id, 'succeeded', { resultRef, completedAt: nowIso() });
        await this.audit(ctx, executionId, 'action.succeeded', { actionId: action.id, sequence: action.sequence, operation: key, attempts: attempt });
        return 'succeeded';
      } catch (error) {
        const c = classifyError(error);
        // Retry only failures that provably had no effect, and only within the policy's budget.
        if (c.retryable && attempt <= maxForwardRetries) {
          await this.audit(ctx, executionId, 'action.retry_scheduled', { actionId: action.id, attempt, nextAttempt: attempt + 1, error: c });
          continue;
        }
        if (c.effect === 'none') return this.failAction(ctx, executionId, action, c, true);
        // Unknown or applied-with-error: never retried blindly. Recovery reconciles it by reading state back.
        await this.repo.updateAction(action.id, 'outcome_unknown', {
          errorCode: c.code,
          errorMessage: c.message,
          errorEffect: c.effect,
          completedAt: nowIso(),
          reconciliation: c.effect === 'applied' ? 'applied' : null,
        });
        await this.audit(ctx, executionId, 'action.outcome_unknown', { actionId: action.id, operation: key, error: c });
        await this.skipRemaining(executionId);
        exe = await this.mustGet(ctx, executionId);
        exe = await this.setStatus(ctx, exe, 'failed', { failureReason: `${key}: ${c.message}`, failureActionId: action.id, completedAt: nowIso() });
        await this.afterHalt(ctx, exe);
        return 'outcome_unknown';
      }
    }
  }

  private async failAction(ctx: CallContext, executionId: string, action: Action, c: ClassifiedError, wasRunning = false): Promise<Action['status']> {
    if (!wasRunning) await this.repo.updateAction(action.id, 'running', { startedAt: nowIso() });
    await this.repo.updateAction(action.id, 'failed', { errorCode: c.code, errorMessage: c.message, errorEffect: c.effect, completedAt: nowIso() });
    await this.audit(ctx, executionId, 'action.failed', { actionId: action.id, sequence: action.sequence, operation: `${action.adapterId}:${action.operation}`, error: c });
    await this.skipRemaining(executionId);
    let exe = await this.mustGet(ctx, executionId);
    exe = await this.setStatus(ctx, exe, 'failed', {
      failureReason: `${action.adapterId}:${action.operation} failed: ${c.message}`,
      failureActionId: action.id,
      completedAt: nowIso(),
    });
    await this.afterHalt(ctx, exe);
    return 'failed';
  }

  private async skipRemaining(executionId: string) {
    for (const a of await this.repo.listActions(executionId)) {
      if (a.status === 'planned' || a.status === 'awaiting_approval') await this.repo.updateAction(a.id, 'skipped', { completedAt: nowIso() });
    }
  }

  /** After forward progress stops: recover automatically if policy allows, otherwise release locks. */
  private async afterHalt(ctx: CallContext, exe: Execution): Promise<Execution> {
    await this.audit(ctx, exe.id, 'execution.halted', { status: exe.status, reason: exe.failureReason });
    const limits = effectiveLimits(await this.repo.listPolicies(ctx.workspaceId));
    const actions = await this.repo.listActions(exe.id);
    const hasEffects = actions.some((a) => a.kind === 'mutation' && (a.status === 'succeeded' || a.status === 'outcome_unknown'));
    if (hasEffects && limits.automatic) {
      // Run outside the forward mutex section's critical path but awaited, so callers see the final state.
      return this.recoverUnlocked({ workspaceId: ctx.workspaceId, actor: { type: 'system', label: 'rewind-engine' } }, exe.id, {
        trigger: 'automatic',
        requestKey: `auto:${exe.id}`,
      });
    }
    if (!hasEffects) {
      await this.audit(ctx, exe.id, 'recovery.not_required', { reason: 'No mutation took effect before the failure.' });
    } else {
      await this.audit(ctx, exe.id, 'recovery.awaiting_request', { reason: 'Automatic recovery is disabled by policy.' });
    }
    await this.releaseLocks(ctx, exe.id);
    return exe;
  }

  // ───────────────────────────── Recovery ─────────────────────────────

  async recover(ctx: CallContext, executionId: string, opts: { requestKey?: string; trigger?: 'manual' | 'retry' } = {}): Promise<Execution> {
    return this.mutex.run(executionId, () =>
      this.recoverUnlocked(ctx, executionId, { trigger: opts.trigger ?? 'manual', requestKey: opts.requestKey ?? newId('rec') }),
    );
  }

  private async recoverUnlocked(ctx: CallContext, executionId: string, opts: { requestKey: string; trigger: RecoveryRequest['trigger'] }): Promise<Execution> {
    let exe = await this.mustGet(ctx, executionId);
    const prior = await this.repo.listRecoveryRequests(executionId);
    const same = prior.find((r) => r.requestKey === opts.requestKey);
    if (same) {
      await this.audit(ctx, executionId, 'recovery.duplicate_ignored', { requestKey: opts.requestKey, existingRequestId: same.id });
      return exe;
    }
    if (exe.status === 'recovering') throw new DomainError('RECOVERY_IN_PROGRESS', 'A recovery is already running for this execution.');
    if (exe.status === 'recovered') throw new DomainError('RECOVERY_NOT_ALLOWED', 'This execution is already fully recovered and verified.');
    if (!RECOVERABLE_EXECUTION_STATUSES.includes(exe.status)) {
      throw new DomainError('RECOVERY_NOT_ALLOWED', `Recovery is not available for an execution that is ${exe.status}.`);
    }
    const limits = effectiveLimits(await this.repo.listPolicies(ctx.workspaceId));
    const isRetry = prior.length > 0;
    if (isRetry && !limits.allowRetry) throw new DomainError('RECOVERY_NOT_ALLOWED', 'Recovery retries are disabled by policy.');
    if (prior.length >= limits.maxRecoveryAttempts) {
      throw new DomainError('RECOVERY_NOT_ALLOWED', `Reached the policy limit of ${limits.maxRecoveryAttempts} recovery requests.`);
    }

    const { request, created } = await this.repo.createRecoveryRequest({ executionId, requestKey: opts.requestKey, trigger: isRetry ? 'retry' : opts.trigger, requestedBy: ctx.actor });
    if (!created) return exe;
    try {
      exe = await this.setStatus(ctx, exe, 'recovering');
    } catch (error) {
      await this.repo.completeRecoveryRequest(request.id, 'interrupted', null, []);
      if (error instanceof DomainError && error.code === 'CONCURRENCY_CONFLICT') throw new DomainError('RECOVERY_IN_PROGRESS', 'Another recovery request won the race.');
      throw error;
    }
    await this.audit(ctx, executionId, 'recovery.requested', { requestId: request.id, trigger: request.trigger, requestKey: opts.requestKey });

    const actions = await this.repo.listActions(executionId);
    const affected = actions.filter((a) => a.kind === 'mutation' && (a.status === 'succeeded' || a.status === 'outcome_unknown'));
    try {
      await this.repo.acquireLocks(ctx.workspaceId, executionId, affected.map((a) => `${a.adapterId}:${a.resourceType}/${a.resourceId}`));
    } catch (error) {
      await this.repo.completeRecoveryRequest(request.id, 'completed', 'recovery_failed', []);
      await this.audit(ctx, executionId, 'recovery.blocked', { reason: error instanceof Error ? error.message : String(error) });
      return this.setStatus(ctx, exe, 'recovery_failed', { completedAt: nowIso() });
    }

    // 1. Reconcile unknown outcomes by reading the resource back.
    for (const a of actions.filter((x) => x.status === 'outcome_unknown' && !x.reconciliation)) {
      a.reconciliation = await this.reconcile(ctx, a);
      await this.repo.patchAction(a.id, { reconciliation: a.reconciliation });
    }

    // 2. Plan.
    const attempts = await this.repo.listRecoveryAttempts(executionId);
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
        reconciliation: a.reconciliation ?? undefined,
        attempts: attempts.filter((t) => t.actionId === a.id).map((t) => ({ attemptNumber: t.attemptNumber, status: t.status, errorEffect: t.errorEffect })),
      };
    });
    const plan = planRecovery(plannable, { maxAttempts: limits.maxRecoveryAttempts, allowRetry: limits.allowRetry });
    const planRecord = plan.steps.map((s) => ({ actionId: s.actionId, sequence: s.sequence, decision: s.decision, reason: s.reason }));
    await this.repo.setRecoveryPlan(request.id, planRecord);
    await this.audit(ctx, executionId, 'recovery.planned', {
      requestId: request.id,
      order: plan.compensations.map((c) => c.sequence),
      steps: planRecord,
    });

    // 3. Compensate in reverse dependency order; 4. verify each.
    const final = new Map<string, RecoveryStatus>();
    const blocked = new Set<number>();
    for (const step of plan.compensations) {
      if (blocked.has(step.sequence)) {
        await this.audit(ctx, executionId, 'compensation.blocked', { actionId: step.actionId, sequence: step.sequence, reason: 'A later step that depends on this one could not be restored.' });
        continue;
      }
      const action = actions.find((a) => a.id === step.actionId)!;
      const status = await this.compensateOne(ctx, request, action, step.attemptNumber);
      final.set(action.id, status);
      if (status !== 'verified') for (const d of transitiveDependencies(plannable, action.sequence)) blocked.add(d);
    }

    // 5. Roll up honestly.
    const outcome = summarizeRecovery(plan.steps.map((s) => ({ decision: s.decision, finalStatus: final.get(s.actionId) })));
    await this.repo.completeRecoveryRequest(request.id, 'completed', outcome, planRecord);
    exe = await this.mustGet(ctx, executionId);
    exe = await this.setStatus(ctx, exe, outcome, { completedAt: nowIso() });
    const unresolved = plan.steps.filter((s) => s.decision !== 'not_required' && s.decision !== 'already_verified' && final.get(s.actionId) !== 'verified');
    await this.audit(ctx, executionId, 'recovery.completed', {
      requestId: request.id,
      outcome,
      verified: [...final.values()].filter((s) => s === 'verified').length,
      unresolvedSideEffects: unresolved.map((s) => ({ actionId: s.actionId, sequence: s.sequence, decision: s.decision, reason: s.reason })),
    });
    await this.releaseLocks(ctx, executionId);
    return exe;
  }

  private async reconcile(ctx: CallContext, a: Action): Promise<'applied' | 'not_applied' | 'inconclusive'> {
    const op = this.registry.resolve(a.adapterId, a.operation);
    const ref = { type: a.resourceType, id: a.resourceId };
    const before = await this.repo.getSnapshot(a.id, 'before');
    let result: 'applied' | 'not_applied' | 'inconclusive' = 'inconclusive';
    let observed: ResourceState | null = null;
    try {
      observed = await withTimeout(op.timeoutMs, (signal) => op.read(ref, { workspaceId: ctx.workspaceId, signal }));
      await this.recordSnapshot(ctx, a.executionId, a.id, 'reconciliation', ref, observed);
      if (before && op.expectedAfter) {
        const input = a.inputRef ? await this.repo.getPayload(a.inputRef) : {};
        const view = (s: ResourceState) => (op.restorationView ? op.restorationView(s) : s.data);
        if (deepEqual(view(observed), view(before.capturedState)) && observed.version === before.resourceVersion) result = 'not_applied';
        else if (deepEqual(observed.data, op.expectedAfter(before.capturedState, input))) result = 'applied';
      }
    } catch {
      result = 'inconclusive';
    }
    await this.audit(ctx, a.executionId, 'reconciliation.completed', { actionId: a.id, result, observedVersion: observed?.version ?? null });
    return result;
  }

  private async compensateOne(ctx: CallContext, request: RecoveryRequest, action: Action, attemptNumber: number): Promise<RecoveryStatus> {
    const op = this.registry.resolve(action.adapterId, action.operation);
    const ref = { type: action.resourceType, id: action.resourceId };
    const key = `${action.adapterId}:${op.name}`;
    const before = await this.repo.getSnapshot(action.id, 'before');
    const after = (await this.repo.getSnapshot(action.id, 'after')) ?? (await this.repo.getSnapshot(action.id, 'reconciliation'));
    const attempt = await this.repo.insertRecoveryAttempt({
      executionId: action.executionId,
      actionId: action.id,
      requestId: request.id,
      status: 'running',
      strategy: op.recovery.capability === 'rollback' ? 'rollback' : 'compensate',
      attemptNumber,
      startedAt: nowIso(),
    });
    await this.audit(ctx, action.executionId, 'compensation.started', { attemptId: attempt.id, actionId: action.id, sequence: action.sequence, operation: key, attemptNumber });

    const end = async (status: RecoveryStatus, patch: Partial<RecoveryAttempt>, eventType: string, payload: Record<string, unknown>) => {
      await this.repo.finishRecoveryAttempt(attempt.id, { status, ...patch });
      await this.audit(ctx, action.executionId, eventType, { attemptId: attempt.id, actionId: action.id, sequence: action.sequence, operation: key, ...payload });
      return status;
    };

    if (!before || !op.compensate) {
      return end('failed', { errorCode: 'NO_SNAPSHOT', errorMessage: 'No captured original state; refusing to guess.', errorEffect: 'none' }, 'compensation.failed', { reason: 'missing snapshot or handler' });
    }

    // Optimistic concurrency: if the resource moved on since REWIND wrote it, do not overwrite it.
    // Prefer the version our own write reported; fall back to the post-write snapshot.
    const result = action.resultRef ? await this.repo.getPayload(action.resultRef) : null;
    const writtenVersion = (result !== null && op.writtenVersion?.(result)) || null;
    const expectedVersion = writtenVersion ?? after?.resourceVersion ?? null;
    try {
      const current = await withTimeout(op.timeoutMs, (signal) => op.read(ref, { workspaceId: ctx.workspaceId, signal }));
      await this.recordSnapshot(ctx, action.executionId, action.id, 'pre_compensation', ref, current);
      if (expectedVersion !== null && current.version !== expectedVersion) {
        const reference = after?.capturedState.data ?? {};
        return end(
          'conflict',
          { errorCode: 'STATE_CONFLICT', errorMessage: `Resource changed after REWIND wrote it (v${expectedVersion} → v${current.version}). Compensation skipped to avoid overwriting another change.`, errorEffect: 'none' },
          'compensation.conflict',
          { expectedVersion, observedVersion: current.version, diffs: diffObjects(reference, current.data) },
        );
      }
    } catch (error) {
      const c = classifyError(error);
      return end('failed', { errorCode: `PRECHECK_FAILED:${c.code}`, errorMessage: c.message, errorEffect: 'none' }, 'compensation.failed', { error: c });
    }

    try {
      const input = action.inputRef ? await this.repo.getPayload(action.inputRef) : {};
      await withTimeout(op.timeoutMs, (signal) => op.compensate!({ workspaceId: ctx.workspaceId, input, before: before.capturedState, after: after?.capturedState ?? null, writtenVersion, signal }));
    } catch (error) {
      const c = classifyError(error);
      if (c.code === 'STATE_CONFLICT') {
        return end('conflict', { errorCode: c.code, errorMessage: c.message, errorEffect: 'none' }, 'compensation.conflict', { error: c });
      }
      return end('failed', { errorCode: c.code, errorMessage: c.message, errorEffect: c.effect }, 'compensation.failed', { error: c });
    }
    await this.audit(ctx, action.executionId, 'compensation.succeeded', { attemptId: attempt.id, actionId: action.id, operation: key, note: 'Handler returned; verification pending.' });

    // Verification: read the resource back. A handler returning is not proof.
    let verification: VerificationResult;
    try {
      const observed = await withTimeout(op.timeoutMs, (signal) => op.read(ref, { workspaceId: ctx.workspaceId, signal }));
      await this.recordSnapshot(ctx, action.executionId, action.id, 'verification', ref, observed);
      const view = (s: ResourceState) => (op.restorationView ? op.restorationView(s) : s.data);
      const expected = view(before.capturedState);
      const got = view(observed);
      verification = { method: 'read_back', restored: deepEqual(expected, got), expected, observed: got, diffs: diffObjects(expected, got), observedVersion: observed.version, checkedAt: nowIso() };
    } catch (error) {
      const c = classifyError(error);
      return end('unverified', { errorCode: `VERIFY_FAILED:${c.code}`, errorMessage: c.message, errorEffect: 'unknown' }, 'verification.failed', { error: c });
    }
    if (verification.restored) {
      return end('verified', { verification }, 'verification.passed', { observedVersion: verification.observedVersion });
    }
    return end(
      'unverified',
      { verification, errorCode: 'STATE_MISMATCH', errorMessage: 'The compensation handler returned, but the resource does not match its original state.', errorEffect: 'applied' },
      'verification.failed',
      { diffs: verification.diffs },
    );
  }

  // ───────────────────────────── Startup reconciliation ─────────────────────────────

  /**
   * After a crash or restart, nothing may stay "running". Interrupted forward
   * actions become outcome_unknown (we cannot know if they applied) and
   * interrupted recoveries are marked so a person can retry them.
   */
  async reconcileInterrupted(): Promise<number> {
    const system: Actor = { type: 'system', label: 'startup-reconciler' };
    let n = 0;
    for (const attempt of await this.repo.findRunningRecoveryAttempts()) {
      await this.repo.finishRecoveryAttempt(attempt.id, { status: 'interrupted', errorCode: 'INTERRUPTED', errorMessage: 'The server stopped during this attempt.', errorEffect: 'unknown' });
    }
    for (const req of await this.repo.findRunningRecoveryRequests()) await this.repo.completeRecoveryRequest(req.id, 'interrupted', null, req.plan);
    for (const exe of await this.repo.findExecutionsByStatus(['running', 'recovering'])) {
      const ctx = { workspaceId: exe.workspaceId, actor: system };
      for (const a of await this.repo.listActions(exe.id)) {
        if (a.status === 'running') {
          await this.repo.updateAction(a.id, 'outcome_unknown', { errorCode: 'INTERRUPTED', errorMessage: 'The server stopped while this action was running.', errorEffect: 'unknown', completedAt: nowIso() });
        }
        if (a.status === 'planned' || a.status === 'awaiting_approval') await this.repo.updateAction(a.id, 'skipped', { completedAt: nowIso() });
      }
      const to: ExecutionStatus = exe.status === 'running' ? 'failed' : 'recovery_failed';
      await this.setStatus(ctx, exe, to, { failureReason: exe.failureReason ?? 'Interrupted by a server restart.', completedAt: nowIso() });
      await this.audit(ctx, exe.id, 'system.interrupted', { previousStatus: exe.status, newStatus: to });
      await this.releaseLocks(ctx, exe.id);
      n++;
    }
    return n;
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  private async mustGet(ctx: CallContext, id: string): Promise<Execution> {
    const exe = await this.repo.getExecution(ctx.workspaceId, id);
    if (!exe) throw new DomainError('NOT_FOUND', `Execution ${id} not found in this workspace.`);
    return exe;
  }

  private async mustGetAction(executionId: string, actionId: string): Promise<Action> {
    const a = await this.repo.getAction(actionId);
    if (!a || a.executionId !== executionId) throw new DomainError('NOT_FOUND', `Action ${actionId} not found.`);
    return a;
  }

  private async setStatus(ctx: CallContext, exe: Execution, to: ExecutionStatus, patch: Parameters<Repository['transitionExecution']>[3] = {}) {
    const next = await this.repo.transitionExecution(exe.id, exe.version, to, patch);
    await this.audit(ctx, exe.id, 'execution.status_changed', { from: exe.status, to });
    this.log.info('execution.status_changed', { executionId: exe.id, from: exe.status, to });
    return next;
  }

  private async recordSnapshot(ctx: CallContext, executionId: string, actionId: string, phase: Parameters<Repository['insertSnapshot']>[0]['phase'], ref: { type: string; id: string }, state: ResourceState) {
    const s = await this.repo.insertSnapshot({ executionId, actionId, phase, resourceType: ref.type, resourceId: ref.id, state });
    await this.audit(ctx, executionId, 'snapshot.captured', { snapshotId: s.id, actionId, phase, resource: `${ref.type}/${ref.id}`, version: state.version, sha256: s.sha256 });
  }

  private async releaseLocks(ctx: CallContext, executionId: string) {
    await this.repo.releaseLocks(executionId);
    void ctx;
  }

  private async audit(ctx: CallContext, executionId: string, eventType: string, payload: Record<string, unknown>) {
    const e = await this.repo.appendAudit({ workspaceId: ctx.workspaceId, executionId, eventType, actor: ctx.actor, payload });
    this.events.emit('event', { workspaceId: ctx.workspaceId, executionId, eventType, seq: e.seq, actorType: ctx.actor.type, payload } satisfies EngineEvent);
  }
}

export type { ActionPolicyResult };
