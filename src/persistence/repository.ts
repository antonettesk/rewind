/**
 * Persistence port and its SQLite implementation.
 *
 * The engine depends only on the `Repository` interface, and every method is
 * async, so a PostgreSQL implementation can replace this class without
 * changing domain or engine code. Methods that must be atomic (state
 * transitions, lock acquisition, idempotent creation) are single methods here
 * so each implementation can give them a real transaction.
 */
import type { ResourceState } from '../adapters/types.js';
import { DomainError } from '../domain/errors.js';
import type { PolicyRuleType } from '../domain/policy.js';
import { redact } from '../domain/redact.js';
import type {
  Action,
  Actor,
  AuditEvent,
  Execution,
  RecoveryAttempt,
  RecoveryRequest,
  SnapshotPhase,
  StateSnapshot,
  StoredPolicy,
  VerificationResult,
  Workspace,
} from '../domain/records.js';
import { assertActionTransition, assertTransition, type ActionStatus, type ExecutionStatus } from '../domain/status.js';
import { canonicalJson, newId, nowIso, sha256 } from '../domain/util.js';
import { transaction, type Db } from './db.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface ExecutionQuery {
  workspaceId: string;
  status?: ExecutionStatus[];
  search?: string;
  limit: number;
  cursor?: string;
}

export interface Repository {
  getWorkspace(id: string): Promise<Workspace | null>;
  ensureWorkspace(id: string, name: string): Promise<Workspace>;
  listWorkspaceIds(): Promise<string[]>;

  createExecution(input: Omit<Execution, 'version' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'failureReason' | 'failureActionId' | 'status'>): Promise<{ execution: Execution; created: boolean }>;
  getExecution(workspaceId: string, id: string): Promise<Execution | null>;
  listExecutions(q: ExecutionQuery): Promise<{ items: Execution[]; nextCursor: string | null }>;
  transitionExecution(id: string, expectedVersion: number, to: ExecutionStatus, patch?: Partial<Pick<Execution, 'failureReason' | 'failureActionId' | 'startedAt' | 'completedAt'>>): Promise<Execution>;
  findExecutionsByStatus(statuses: ExecutionStatus[]): Promise<Execution[]>;

  insertAction(action: Omit<Action, 'id' | 'createdAt'>): Promise<Action>;
  getAction(id: string): Promise<Action | null>;
  listActions(executionId: string): Promise<Action[]>;
  /** One query for list views: step count, adapters and failure step per execution. */
  actionSummaries(executionIds: string[]): Promise<Map<string, { count: number; adapters: string[]; failure: Map<string, { sequence: number; operation: string }> }>>;
  usage(workspaceId: string, sinceIso: string): Promise<{ executions: number; mcpExecutions: number; verifiedRecoveries: number; failedRecoveries: number; approvals: number }>;
  updateAction(id: string, to: ActionStatus, patch: Partial<Action>): Promise<Action>;
  patchAction(id: string, patch: Partial<Pick<Action, 'forwardAttempts' | 'reconciliation' | 'approvedBy'>>): Promise<void>;

  putPayload(value: unknown): Promise<string>;
  getPayload(id: string): Promise<unknown>;

  insertSnapshot(s: { executionId: string; actionId: string; phase: SnapshotPhase; resourceType: string; resourceId: string; state: ResourceState }): Promise<StateSnapshot>;
  listSnapshots(executionId: string): Promise<StateSnapshot[]>;
  getSnapshot(actionId: string, phase: SnapshotPhase): Promise<StateSnapshot | null>;

  createRecoveryRequest(r: Omit<RecoveryRequest, 'id' | 'createdAt' | 'completedAt' | 'outcome' | 'status' | 'plan'>): Promise<{ request: RecoveryRequest; created: boolean }>;
  completeRecoveryRequest(id: string, status: RecoveryRequest['status'], outcome: RecoveryRequest['outcome'], plan: RecoveryRequest['plan']): Promise<void>;
  setRecoveryPlan(id: string, plan: RecoveryRequest['plan']): Promise<void>;
  listRecoveryRequests(executionId: string): Promise<RecoveryRequest[]>;
  findRunningRecoveryRequests(): Promise<RecoveryRequest[]>;

  insertRecoveryAttempt(a: Omit<RecoveryAttempt, 'id' | 'completedAt' | 'verification' | 'errorCode' | 'errorMessage' | 'errorEffect'>): Promise<RecoveryAttempt>;
  finishRecoveryAttempt(id: string, patch: Pick<RecoveryAttempt, 'status'> & Partial<Pick<RecoveryAttempt, 'verification' | 'errorCode' | 'errorMessage' | 'errorEffect'>>): Promise<RecoveryAttempt>;
  listRecoveryAttempts(executionId: string): Promise<RecoveryAttempt[]>;
  listRecentRecoveryAttempts(workspaceId: string, limit: number): Promise<(RecoveryAttempt & { taskDescription: string; operation: string; adapterId: string })[]>;
  findRunningRecoveryAttempts(): Promise<RecoveryAttempt[]>;

  acquireLocks(workspaceId: string, executionId: string, resourceKeys: string[]): Promise<void>;
  releaseLocks(executionId: string): Promise<void>;
  listLocks(workspaceId: string): Promise<{ resourceKey: string; executionId: string; acquiredAt: string }[]>;

  appendAudit(e: { workspaceId: string; executionId: string | null; eventType: string; actor: Actor; payload: Record<string, unknown> }): Promise<AuditEvent>;
  listAudit(executionId: string): Promise<AuditEvent[]>;
  listWorkspaceAudit(workspaceId: string, limit: number): Promise<AuditEvent[]>;

  listPolicies(workspaceId: string): Promise<StoredPolicy[]>;
  getPolicy(workspaceId: string, id: string): Promise<StoredPolicy | null>;
  insertPolicy(p: Omit<StoredPolicy, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<StoredPolicy>;
  updatePolicy(workspaceId: string, id: string, expectedVersion: number, patch: { enabled?: boolean; configuration?: Record<string, unknown> }): Promise<StoredPolicy>;

  stats(workspaceId: string): Promise<WorkspaceStats>;
  /** Deletes executions, traces and audit history for a workspace. Explicit, confirmed operation only. */
  purgeWorkspaceHistory(workspaceId: string): Promise<{ executions: number }>;
  /** Retention: delete terminal executions older than the cutoff. */
  purgeOlderThan(workspaceId: string, cutoffIso: string): Promise<{ executions: number }>;
  ping(): Promise<void>;
}

export interface WorkspaceStats {
  total: number;
  byStatus: Record<string, number>;
  failuresRecoverable: number;
  failuresNonRecoverable: number;
  recoveryAttempts: number;
  recoveryVerified: number;
}

type Row = Record<string, any>;
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

function toExecution(r: Row): Execution {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    taskDescription: r.task_description,
    status: r.status,
    version: r.version,
    source: r.source,
    actor: parse(r.actor_json, { type: 'system', label: 'unknown' }),
    environment: r.environment,
    metadata: parse(r.metadata_json, {}),
    failureReason: r.failure_reason ?? null,
    failureActionId: r.failure_action_id ?? null,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    updatedAt: r.updated_at,
  };
}

function toAction(r: Row): Action {
  return {
    id: r.id,
    executionId: r.execution_id,
    sequence: r.sequence,
    adapterId: r.adapter_id,
    operation: r.operation,
    kind: r.kind,
    status: r.status,
    dependsOn: parse<number[] | null>(r.depends_on_json, null),
    dedupeKey: r.dedupe_key ?? null,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    inputRef: r.input_ref ?? null,
    resultRef: r.result_ref ?? null,
    policy: parse(r.policy_json, { decision: 'deny', matched: [], reason: '' }),
    forwardAttempts: r.forward_attempts,
    reconciliation: r.reconciliation ?? null,
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    errorEffect: r.error_effect ?? null,
    approvedBy: r.approved_by ?? null,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
  };
}

function toSnapshot(r: Row): StateSnapshot {
  return {
    id: r.id,
    executionId: r.execution_id,
    actionId: r.action_id,
    phase: r.phase,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    resourceVersion: r.resource_version,
    capturedState: JSON.parse(r.captured_state_json),
    sha256: r.sha256,
    capturedAt: r.captured_at,
  };
}

function toRequest(r: Row): RecoveryRequest {
  return {
    id: r.id,
    executionId: r.execution_id,
    requestKey: r.request_key,
    trigger: r.trigger,
    requestedBy: parse(r.requested_by_json, { type: 'system', label: 'unknown' }),
    status: r.status,
    outcome: r.outcome ?? null,
    plan: parse(r.plan_json, []),
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
  };
}

function toAttempt(r: Row): RecoveryAttempt {
  return {
    id: r.id,
    executionId: r.execution_id,
    actionId: r.action_id,
    requestId: r.request_id,
    status: r.status,
    strategy: r.strategy,
    attemptNumber: r.attempt_number,
    verification: parse<VerificationResult | null>(r.verification_json, null),
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    errorEffect: r.error_effect ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null,
  };
}

function toPolicy(r: Row): StoredPolicy {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    ruleType: r.rule_type as PolicyRuleType,
    configuration: JSON.parse(r.configuration_json),
    enabled: r.enabled === 1,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAudit(r: Row): AuditEvent {
  return {
    seq: r.seq,
    id: r.id,
    workspaceId: r.workspace_id,
    executionId: r.execution_id ?? null,
    eventType: r.event_type,
    actorType: r.actor_type,
    actor: JSON.parse(r.actor_json),
    payload: JSON.parse(r.payload_json),
    payloadSha256: r.payload_sha256,
    timestamp: r.timestamp,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);
}

export class SqliteRepository implements Repository {
  constructor(private readonly db: Db) {}

  async ping() {
    this.db.prepare('SELECT 1').get();
  }

  async getWorkspace(id: string) {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  async listWorkspaceIds() {
    return (this.db.prepare('SELECT id FROM workspaces').all() as Row[]).map((r) => r.id as string);
  }

  async ensureWorkspace(id: string, name: string) {
    const t = nowIso();
    this.db.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, t, t);
    return (await this.getWorkspace(id))!;
  }

  async createExecution(input: Parameters<Repository['createExecution']>[0]) {
    const t = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO executions (id, workspace_id, idempotency_key, request_hash, task_description, status, version, source, actor_json,
             environment, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.workspaceId, input.idempotencyKey, input.requestHash, input.taskDescription, input.source, json(input.actor), input.environment, json(input.metadata), t, t);
      return { execution: (await this.getExecution(input.workspaceId, input.id))!, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this.db.prepare('SELECT * FROM executions WHERE workspace_id = ? AND idempotency_key = ?').get(input.workspaceId, input.idempotencyKey) as Row | undefined;
      if (!existing) throw error;
      const execution = toExecution(existing);
      if (execution.requestHash !== input.requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.', { executionId: execution.id });
      }
      return { execution, created: false };
    }
  }

  async getExecution(workspaceId: string, id: string) {
    const r = this.db.prepare('SELECT * FROM executions WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    return r ? toExecution(r) : null;
  }

  async listExecutions(q: ExecutionQuery) {
    const where = ['workspace_id = ?'];
    const args: (string | number)[] = [q.workspaceId];
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(',')})`);
      args.push(...q.status);
    }
    if (q.search) {
      where.push("(task_description LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (q.cursor) {
      const [createdAt, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
      if (!createdAt || !id) throw new DomainError('VALIDATION_FAILED', 'Invalid cursor.');
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(createdAt, createdAt, id);
    }
    const rows = this.db.prepare(`SELECT * FROM executions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, q.limit + 1) as Row[];
    const items = rows.slice(0, q.limit).map(toExecution);
    const last = items.at(-1);
    const nextCursor = rows.length > q.limit && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null;
    return { items, nextCursor };
  }

  async transitionExecution(id: string, expectedVersion: number, to: ExecutionStatus, patch: Parameters<Repository['transitionExecution']>[3] = {}) {
    return transaction(this.db, () => {
      const r = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new DomainError('NOT_FOUND', `Execution ${id} not found.`);
      const current = toExecution(r);
      if (current.version !== expectedVersion) {
        throw new DomainError('CONCURRENCY_CONFLICT', `Execution ${id} changed concurrently (expected v${expectedVersion}, found v${current.version}).`);
      }
      assertTransition(current.status, to);
      const sets = ['status = ?', 'version = version + 1', 'updated_at = ?'];
      const args: (string | number | null)[] = [to, nowIso()];
      const cols: Record<string, string> = { failureReason: 'failure_reason', failureActionId: 'failure_action_id', startedAt: 'started_at', completedAt: 'completed_at' };
      for (const [k, col] of Object.entries(cols)) {
        if (k in patch) {
          sets.push(`${col} = ?`);
          args.push((patch as Record<string, string | null>)[k] ?? null);
        }
      }
      const res = this.db.prepare(`UPDATE executions SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...args, id, expectedVersion);
      if (res.changes !== 1) throw new DomainError('CONCURRENCY_CONFLICT', `Execution ${id} changed concurrently.`);
      return toExecution(this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row);
    });
  }

  async findExecutionsByStatus(statuses: ExecutionStatus[]) {
    return (this.db.prepare(`SELECT * FROM executions WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as Row[]).map(toExecution);
  }

  async insertAction(a: Omit<Action, 'id' | 'createdAt'>) {
    const id = newId('act');
    try {
      this.db
        .prepare(
          `INSERT INTO actions (id, execution_id, sequence, adapter_id, operation, kind, status, depends_on_json, dedupe_key, resource_type, resource_id,
             input_ref, result_ref, policy_json, forward_attempts, reconciliation, error_code, error_message, error_effect, approved_by, created_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, a.executionId, a.sequence, a.adapterId, a.operation, a.kind, a.status, json(a.dependsOn), a.dedupeKey, a.resourceType, a.resourceId, a.inputRef, a.resultRef, json(a.policy), a.forwardAttempts, a.reconciliation, a.errorCode, a.errorMessage, a.errorEffect, a.approvedBy, nowIso(), a.startedAt, a.completedAt);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('CONCURRENCY_CONFLICT', 'An action with this sequence or dedupe key already exists.');
      throw error;
    }
    return (await this.getAction(id))!;
  }

  async getAction(id: string) {
    const r = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row | undefined;
    return r ? toAction(r) : null;
  }

  async actionSummaries(executionIds: string[]) {
    const out = new Map<string, { count: number; adapters: string[]; failure: Map<string, { sequence: number; operation: string }> }>();
    if (!executionIds.length) return out;
    const rows = this.db
      .prepare(`SELECT id, execution_id, sequence, adapter_id, operation FROM actions WHERE execution_id IN (${executionIds.map(() => '?').join(',')})`)
      .all(...executionIds) as Row[];
    for (const r of rows) {
      const e = out.get(r.execution_id) ?? { count: 0, adapters: [] as string[], failure: new Map<string, { sequence: number; operation: string }>() };
      e.count++;
      if (!e.adapters.includes(r.adapter_id)) e.adapters.push(r.adapter_id);
      e.failure.set(r.id, { sequence: r.sequence, operation: `${r.adapter_id}:${r.operation}` });
      out.set(r.execution_id, e);
    }
    return out;
  }

  async usage(workspaceId: string, sinceIso: string) {
    const one = (sql: string, ...args: (string | number)[]) => Number((this.db.prepare(sql).get(...args) as Row).n ?? 0);
    return {
      executions: one('SELECT COUNT(*) AS n FROM executions WHERE workspace_id = ? AND created_at >= ?', workspaceId, sinceIso),
      mcpExecutions: one("SELECT COUNT(*) AS n FROM executions WHERE workspace_id = ? AND created_at >= ? AND actor_json LIKE '%\"mcp_client\"%'", workspaceId, sinceIso),
      verifiedRecoveries: one("SELECT COUNT(*) AS n FROM recovery_attempts ra JOIN executions e ON e.id = ra.execution_id WHERE e.workspace_id = ? AND ra.started_at >= ? AND ra.status = 'verified'", workspaceId, sinceIso),
      failedRecoveries: one("SELECT COUNT(*) AS n FROM recovery_attempts ra JOIN executions e ON e.id = ra.execution_id WHERE e.workspace_id = ? AND ra.started_at >= ? AND ra.status IN ('failed','unverified','conflict')", workspaceId, sinceIso),
      approvals: one("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND timestamp >= ? AND event_type = 'approval.granted'", workspaceId, sinceIso),
    };
  }

  async listActions(executionId: string) {
    return (this.db.prepare('SELECT * FROM actions WHERE execution_id = ? ORDER BY sequence').all(executionId) as Row[]).map(toAction);
  }

  async updateAction(id: string, to: ActionStatus, patch: Partial<Action>) {
    return transaction(this.db, () => {
      const current = toAction(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row);
      assertActionTransition(current.status, to);
      const map: Record<string, string> = {
        resultRef: 'result_ref', errorCode: 'error_code', errorMessage: 'error_message', errorEffect: 'error_effect',
        startedAt: 'started_at', completedAt: 'completed_at', forwardAttempts: 'forward_attempts', reconciliation: 'reconciliation', approvedBy: 'approved_by',
      };
      const sets = ['status = ?'];
      const args: (string | number | null)[] = [to];
      for (const [k, col] of Object.entries(map)) {
        if (k in patch) {
          sets.push(`${col} = ?`);
          args.push((patch as Record<string, string | number | null>)[k] ?? null);
        }
      }
      const res = this.db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...args, id, current.status);
      if (res.changes !== 1) throw new DomainError('CONCURRENCY_CONFLICT', `Action ${id} changed concurrently.`);
      return toAction(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row);
    });
  }

  async patchAction(id: string, patch: Parameters<Repository['patchAction']>[1]) {
    if ('forwardAttempts' in patch) this.db.prepare('UPDATE actions SET forward_attempts = ? WHERE id = ?').run(patch.forwardAttempts!, id);
    if ('reconciliation' in patch) this.db.prepare('UPDATE actions SET reconciliation = ? WHERE id = ?').run(patch.reconciliation ?? null, id);
    if ('approvedBy' in patch) this.db.prepare('UPDATE actions SET approved_by = ? WHERE id = ?').run(patch.approvedBy ?? null, id);
  }

  async putPayload(value: unknown) {
    let text = canonicalJson(redact(value));
    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
      text = canonicalJson({ truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, 4096) });
    }
    const id = newId('pay');
    this.db.prepare('INSERT INTO payloads (id, sha256, bytes, json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, sha256(text), Buffer.byteLength(text), text, nowIso());
    return id;
  }

  async getPayload(id: string) {
    const r = this.db.prepare('SELECT json FROM payloads WHERE id = ?').get(id) as Row | undefined;
    return r ? JSON.parse(r.json) : null;
  }

  async insertSnapshot(s: Parameters<Repository['insertSnapshot']>[0]) {
    const id = newId('snp');
    const text = canonicalJson(s.state);
    this.db
      .prepare('INSERT INTO state_snapshots (id, execution_id, action_id, phase, resource_type, resource_id, resource_version, captured_state_json, sha256, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.executionId, s.actionId, s.phase, s.resourceType, s.resourceId, s.state.version, text, sha256(text), nowIso());
    return toSnapshot(this.db.prepare('SELECT * FROM state_snapshots WHERE id = ?').get(id) as Row);
  }

  async listSnapshots(executionId: string) {
    return (this.db.prepare('SELECT * FROM state_snapshots WHERE execution_id = ? ORDER BY captured_at, rowid').all(executionId) as Row[]).map(toSnapshot);
  }

  async getSnapshot(actionId: string, phase: SnapshotPhase) {
    const r = this.db.prepare('SELECT * FROM state_snapshots WHERE action_id = ? AND phase = ? ORDER BY rowid LIMIT 1').get(actionId, phase) as Row | undefined;
    return r ? toSnapshot(r) : null;
  }

  async createRecoveryRequest(r: Parameters<Repository['createRecoveryRequest']>[0]) {
    const id = newId('rec');
    try {
      this.db
        .prepare("INSERT INTO recovery_requests (id, execution_id, request_key, trigger, requested_by_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
        .run(id, r.executionId, r.requestKey, r.trigger, json(r.requestedBy), nowIso());
      return { request: toRequest(this.db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(id) as Row), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this.db.prepare('SELECT * FROM recovery_requests WHERE execution_id = ? AND request_key = ?').get(r.executionId, r.requestKey) as Row;
      return { request: toRequest(existing), created: false };
    }
  }

  async completeRecoveryRequest(id: string, status: RecoveryRequest['status'], outcome: RecoveryRequest['outcome'], plan: RecoveryRequest['plan']) {
    this.db.prepare('UPDATE recovery_requests SET status = ?, outcome = ?, plan_json = ?, completed_at = ? WHERE id = ?').run(status, outcome, json(plan), nowIso(), id);
  }

  async setRecoveryPlan(id: string, plan: RecoveryRequest['plan']) {
    this.db.prepare('UPDATE recovery_requests SET plan_json = ? WHERE id = ?').run(json(plan), id);
  }

  async listRecoveryRequests(executionId: string) {
    return (this.db.prepare('SELECT * FROM recovery_requests WHERE execution_id = ? ORDER BY created_at, rowid').all(executionId) as Row[]).map(toRequest);
  }

  async findRunningRecoveryRequests() {
    return (this.db.prepare("SELECT * FROM recovery_requests WHERE status = 'running'").all() as Row[]).map(toRequest);
  }

  async insertRecoveryAttempt(a: Parameters<Repository['insertRecoveryAttempt']>[0]) {
    const id = newId('rec');
    try {
      this.db
        .prepare('INSERT INTO recovery_attempts (id, execution_id, action_id, request_id, status, strategy, attempt_number, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, a.executionId, a.actionId, a.requestId, a.status, a.strategy, a.attemptNumber, a.startedAt);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('RECOVERY_IN_PROGRESS', 'This recovery attempt is already recorded.');
      throw error;
    }
    return toAttempt(this.db.prepare('SELECT * FROM recovery_attempts WHERE id = ?').get(id) as Row);
  }

  async finishRecoveryAttempt(id: string, patch: Parameters<Repository['finishRecoveryAttempt']>[1]) {
    this.db
      .prepare('UPDATE recovery_attempts SET status = ?, verification_json = ?, error_code = ?, error_message = ?, error_effect = ?, completed_at = ? WHERE id = ?')
      .run(patch.status, patch.verification ? json(patch.verification) : null, patch.errorCode ?? null, patch.errorMessage ?? null, patch.errorEffect ?? null, nowIso(), id);
    return toAttempt(this.db.prepare('SELECT * FROM recovery_attempts WHERE id = ?').get(id) as Row);
  }

  async listRecoveryAttempts(executionId: string) {
    return (this.db.prepare('SELECT * FROM recovery_attempts WHERE execution_id = ? ORDER BY started_at, rowid').all(executionId) as Row[]).map(toAttempt);
  }

  async listRecentRecoveryAttempts(workspaceId: string, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT ra.*, e.task_description, a.operation, a.adapter_id FROM recovery_attempts ra
         JOIN executions e ON e.id = ra.execution_id JOIN actions a ON a.id = ra.action_id
         WHERE e.workspace_id = ? ORDER BY ra.started_at DESC, ra.rowid DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Row[];
    return rows.map((r) => ({ ...toAttempt(r), taskDescription: r.task_description, operation: r.operation, adapterId: r.adapter_id }));
  }

  async findRunningRecoveryAttempts() {
    return (this.db.prepare("SELECT * FROM recovery_attempts WHERE status IN ('pending', 'running')").all() as Row[]).map(toAttempt);
  }

  async acquireLocks(workspaceId: string, executionId: string, resourceKeys: string[]) {
    transaction(this.db, () => {
      // Lock keys are scoped by workspace: each workspace has its own resources.
      for (const key of [...new Set(resourceKeys)].sort().map((k) => `${workspaceId}|${k}`)) {
        const held = this.db.prepare('SELECT execution_id FROM resource_locks WHERE resource_key = ?').get(key) as Row | undefined;
        if (held && held.execution_id !== executionId) {
          const resource = key.slice(key.indexOf('|') + 1);
          throw new DomainError('RESOURCE_LOCKED', `Resource ${resource} is held by execution ${held.execution_id}.`, { resource, heldBy: held.execution_id });
        }
        if (!held) this.db.prepare('INSERT INTO resource_locks (resource_key, workspace_id, execution_id, acquired_at) VALUES (?, ?, ?, ?)').run(key, workspaceId, executionId, nowIso());
      }
    });
  }

  async releaseLocks(executionId: string) {
    this.db.prepare('DELETE FROM resource_locks WHERE execution_id = ?').run(executionId);
  }

  async listLocks(workspaceId: string) {
    return (this.db.prepare('SELECT * FROM resource_locks WHERE workspace_id = ? ORDER BY acquired_at').all(workspaceId) as Row[]).map((r) => ({
      resourceKey: String(r.resource_key).slice(String(r.resource_key).indexOf('|') + 1),
      executionId: r.execution_id,
      acquiredAt: r.acquired_at,
    }));
  }

  async appendAudit(e: Parameters<Repository['appendAudit']>[0]) {
    const id = newId('evt');
    const payload = canonicalJson(redact(e.payload));
    const t = nowIso();
    this.db
      .prepare('INSERT INTO audit_events (id, workspace_id, execution_id, event_type, actor_type, actor_json, payload_json, payload_sha256, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, e.workspaceId, e.executionId, e.eventType, e.actor.type, json(redact(e.actor)), payload, sha256(payload), t);
    return toAudit(this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as Row);
  }

  async listAudit(executionId: string) {
    return (this.db.prepare('SELECT * FROM audit_events WHERE execution_id = ? ORDER BY seq').all(executionId) as Row[]).map(toAudit);
  }

  async listWorkspaceAudit(workspaceId: string, limit: number) {
    return (this.db.prepare('SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?').all(workspaceId, limit) as Row[]).map(toAudit);
  }

  async listPolicies(workspaceId: string) {
    return (this.db.prepare('SELECT * FROM policies WHERE workspace_id = ? ORDER BY created_at, rowid').all(workspaceId) as Row[]).map(toPolicy);
  }

  async getPolicy(workspaceId: string, id: string) {
    const r = this.db.prepare('SELECT * FROM policies WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    return r ? toPolicy(r) : null;
  }

  async insertPolicy(p: Parameters<Repository['insertPolicy']>[0]) {
    const id = p.id ?? newId('pol');
    const t = nowIso();
    this.db
      .prepare('INSERT INTO policies (id, workspace_id, name, description, rule_type, configuration_json, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, p.workspaceId, p.name, p.description, p.ruleType, json(p.configuration), p.enabled ? 1 : 0, t, t);
    return (await this.getPolicy(p.workspaceId, id))!;
  }

  async updatePolicy(workspaceId: string, id: string, expectedVersion: number, patch: { enabled?: boolean; configuration?: Record<string, unknown> }) {
    const current = await this.getPolicy(workspaceId, id);
    if (!current) throw new DomainError('NOT_FOUND', `Policy ${id} not found.`);
    const res = this.db
      .prepare('UPDATE policies SET enabled = ?, configuration_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND version = ?')
      .run((patch.enabled ?? current.enabled) ? 1 : 0, json(patch.configuration ?? current.configuration), nowIso(), id, workspaceId, expectedVersion);
    if (res.changes !== 1) throw new DomainError('CONCURRENCY_CONFLICT', 'The policy was changed by someone else. Reload and try again.');
    return (await this.getPolicy(workspaceId, id))!;
  }

  async stats(workspaceId: string): Promise<WorkspaceStats> {
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM executions WHERE workspace_id = ? GROUP BY status').all(workspaceId) as Row[]) {
      byStatus[r.status] = r.n;
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const attempts = this.db
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN ra.status = 'verified' THEN 1 ELSE 0 END) AS v FROM recovery_attempts ra JOIN executions e ON e.id = ra.execution_id WHERE e.workspace_id = ?")
      .get(workspaceId) as Row;
    return {
      total,
      byStatus,
      failuresRecoverable: byStatus.recovered ?? 0,
      failuresNonRecoverable: (byStatus.partially_recovered ?? 0) + (byStatus.recovery_failed ?? 0),
      recoveryAttempts: attempts.n ?? 0,
      recoveryVerified: attempts.v ?? 0,
    };
  }

  async purgeWorkspaceHistory(workspaceId: string) {
    return this.purge(workspaceId, null);
  }

  async purgeOlderThan(workspaceId: string, cutoffIso: string) {
    return this.purge(workspaceId, cutoffIso);
  }

  private purge(workspaceId: string, cutoff: string | null) {
    return transaction(this.db, () => {
      const filter = cutoff ? "AND created_at < ? AND status IN ('succeeded','recovered','partially_recovered','recovery_failed','cancelled','failed')" : '';
      const ids = (this.db.prepare(`SELECT id FROM executions WHERE workspace_id = ? ${filter}`).all(...(cutoff ? [workspaceId, cutoff] : [workspaceId])) as Row[]).map((r) => r.id as string);
      this.db.exec('UPDATE maintenance SET enabled = 1 WHERE id = 1');
      try {
        for (const id of ids) {
          const refs = (this.db.prepare('SELECT input_ref, result_ref FROM actions WHERE execution_id = ?').all(id) as Row[]).flatMap((r) => [r.input_ref, r.result_ref]).filter(Boolean);
          for (const t of ['recovery_attempts', 'recovery_requests', 'state_snapshots', 'audit_events', 'actions', 'resource_locks']) {
            this.db.prepare(`DELETE FROM ${t} WHERE execution_id = ?`).run(id);
          }
          for (const ref of refs) this.db.prepare('DELETE FROM payloads WHERE id = ?').run(ref);
          this.db.prepare('DELETE FROM executions WHERE id = ?').run(id);
        }
      } finally {
        this.db.exec('UPDATE maintenance SET enabled = 0 WHERE id = 1');
      }
      return { executions: ids.length };
    });
  }
}
