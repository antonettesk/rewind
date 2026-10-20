import type { OperationKind, ResourceState } from '../adapters/types.js';
import type { EffectCertainty } from './errors.js';
import type { ActionPolicyResult, PolicyRecord } from './policy.js';
import type { ActionStatus, ExecutionStatus, RecoveryStatus } from './status.js';
import type { FieldDiff } from './util.js';

export type ActorType = 'mcp_client' | 'http_api' | 'web_ui' | 'system' | 'test';

export interface Actor {
  type: ActorType;
  /** Free-form label, e.g. the MCP client name. Never a credential. */
  label: string;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Execution {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  taskDescription: string;
  status: ExecutionStatus;
  version: number;
  source: string;
  actor: Actor;
  environment: string;
  metadata: Record<string, unknown>;
  failureReason: string | null;
  failureActionId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface Action {
  id: string;
  executionId: string;
  sequence: number;
  adapterId: string;
  operation: string;
  kind: OperationKind;
  status: ActionStatus;
  /** null: depends on the previous action. [] : independent. */
  dependsOn: number[] | null;
  dedupeKey: string | null;
  resourceType: string;
  resourceId: string;
  inputRef: string | null;
  resultRef: string | null;
  policy: ActionPolicyResult;
  forwardAttempts: number;
  reconciliation: 'applied' | 'not_applied' | 'inconclusive' | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorEffect: EffectCertainty | null;
  approvedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type SnapshotPhase = 'before' | 'after' | 'reconciliation' | 'pre_compensation' | 'verification';

export interface StateSnapshot {
  id: string;
  executionId: string;
  actionId: string;
  phase: SnapshotPhase;
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  capturedState: ResourceState;
  sha256: string;
  capturedAt: string;
}

export interface VerificationResult {
  method: 'read_back';
  restored: boolean;
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  diffs: FieldDiff[];
  observedVersion: number;
  checkedAt: string;
}

export interface RecoveryRequest {
  id: string;
  executionId: string;
  requestKey: string;
  trigger: 'automatic' | 'manual' | 'retry';
  requestedBy: Actor;
  status: 'running' | 'completed' | 'interrupted';
  outcome: 'recovered' | 'partially_recovered' | 'recovery_failed' | null;
  plan: { actionId: string; sequence: number; decision: string; reason: string }[];
  createdAt: string;
  completedAt: string | null;
}

export interface RecoveryAttempt {
  id: string;
  executionId: string;
  actionId: string;
  requestId: string;
  status: RecoveryStatus;
  strategy: 'compensate' | 'rollback';
  attemptNumber: number;
  verification: VerificationResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorEffect: EffectCertainty | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AuditEvent {
  seq: number;
  id: string;
  workspaceId: string;
  executionId: string | null;
  eventType: string;
  actorType: ActorType;
  actor: Actor;
  payload: Record<string, unknown>;
  payloadSha256: string;
  timestamp: string;
}

export interface StoredPolicy extends PolicyRecord {
  workspaceId: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
