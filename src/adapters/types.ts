/**
 * The adapter contract. An adapter is the only way Rewind touches the outside
 * world. Each operation declares, up front and in code, what it does and what
 * recovery it supports; the engine never infers recoverability.
 */
import type { z } from 'zod/v4';

export type OperationKind = 'read' | 'mutation';

/**
 * - compensatable: a separate operation can restore the previous business state
 * - rollback:      the target system offers a genuine transactional rollback
 * - irreversible:  the effect cannot be undone (a sent message, a disclosed secret)
 * - none:          reads; nothing to recover
 */
export type RecoveryCapability = 'compensatable' | 'rollback' | 'irreversible' | 'none';

export interface ResourceRef {
  type: string;
  id: string;
}

/** State as read from a resource, including its version for optimistic checks. */
export interface ResourceState {
  version: number;
  /** The business state. This is what restoration is judged against. */
  data: Record<string, unknown>;
  /** Fields that change on every write and are excluded from restoration checks. */
  meta?: Record<string, unknown>;
}

/** Every adapter call is scoped to one workspace; adapters must never read or write across workspaces. */
export interface ReadContext {
  workspaceId: string;
  signal: AbortSignal;
}

export interface OperationContext {
  workspaceId: string;
  executionId: string;
  actionId: string;
  signal: AbortSignal;
}

export interface CompensationInput<I> {
  workspaceId: string;
  input: I;
  /** State captured before the forward action ran. Immutable. */
  before: ResourceState;
  /** State captured right after the forward action succeeded, if available. */
  after: ResourceState | null;
  /**
   * The resource version Rewind's own write produced, if known. Compensation
   * must refuse to write if the resource has moved past this version.
   */
  writtenVersion: number | null;
  signal: AbortSignal;
}

export interface OperationDefinition<I = any, O = unknown> {
  name: string;
  title: string;
  description: string;
  kind: OperationKind;
  inputSchema: z.ZodType<I>;
  /** Least-privilege permission strings this operation needs. */
  permissions: string[];
  recovery: {
    capability: RecoveryCapability;
    /** True if running the compensation twice is harmless. Gates recovery retries. */
    idempotentCompensation: boolean;
    summary: string;
  };
  timeoutMs: number;
  /** Which resource this call touches. Used for snapshots and locking. */
  resource(input: I): ResourceRef;
  /** Read the resource. Required for mutations so state can be captured and verified. */
  read(ref: ResourceRef, ctx: ReadContext): Promise<ResourceState>;
  execute(input: I, ctx: OperationContext): Promise<O>;
  /** Extract the resource version this call's write produced from its result. */
  writtenVersion?(result: O): number | undefined;
  /**
   * The state the resource should be in after a successful call, given the
   * state before it. Used to reconcile timeouts: if the resource matches this,
   * the effect applied.
   */
  expectedAfter?(before: ResourceState, input: I): Record<string, unknown>;
  compensate?(args: CompensationInput<I>): Promise<void>;
  /** Defaults to a field-by-field comparison of `data` against `before.data`. */
  restorationView?(state: ResourceState): Record<string, unknown>;
}

export type AdapterType = 'local-simulation' | 'http' | 'database' | 'saas';

export interface AdapterHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  checkedAt: string;
  detail: string;
}

export interface Adapter {
  id: string;
  name: string;
  type: AdapterType;
  version: string;
  description: string;
  /** Shown verbatim in the registry so nobody mistakes a simulation for a real device. */
  disclosure: string;
  operations: OperationDefinition[];
  /** A real check against the adapter's backing store, not a constant. */
  health(): Promise<AdapterHealth>;
}

/** Serializable description used by the UI, the API and MCP discovery. */
export interface OperationDescriptor {
  adapterId: string;
  name: string;
  key: string;
  title: string;
  description: string;
  kind: OperationKind;
  permissions: string[];
  recovery: OperationDefinition['recovery'];
  timeoutMs: number;
  inputJsonSchema: unknown;
}
