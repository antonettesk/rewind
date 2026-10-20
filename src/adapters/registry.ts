import { z } from 'zod/v4';
import { DomainError } from '../domain/errors.js';
import type { Adapter, OperationDefinition, OperationDescriptor } from './types.js';

/**
 * The operation registry. A call resolves only if both the adapter id and the
 * operation name are registered here; there is no fallback and no dynamic
 * dispatch on caller-supplied names.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter "${adapter.id}" is already registered.`);
    validateAdapter(adapter);
    this.adapters.set(adapter.id, adapter);
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }

  getAdapter(adapterId: string): Adapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new DomainError('UNKNOWN_OPERATION', `No adapter "${adapterId}" is registered.`, { adapterId });
    return adapter;
  }

  resolve(adapterId: string, operationName: string): OperationDefinition {
    const op = this.getAdapter(adapterId).operations.find((o) => o.name === operationName);
    if (!op) {
      throw new DomainError('UNKNOWN_OPERATION', `Adapter "${adapterId}" has no operation "${operationName}".`, {
        adapterId,
        operation: operationName,
      });
    }
    return op;
  }

  /** Parse caller input with the operation's own schema. Throws VALIDATION_FAILED. */
  parseInput(op: OperationDefinition, input: unknown): unknown {
    const result = op.inputSchema.safeParse(input ?? {});
    if (!result.success) {
      throw new DomainError('VALIDATION_FAILED', `Invalid input for ${op.name}: ${z.prettifyError(result.error)}`, {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }

  describe(): OperationDescriptor[] {
    return this.list().flatMap((a) => a.operations.map((op) => describeOperation(a.id, op)));
  }
}

export function describeOperation(adapterId: string, op: OperationDefinition): OperationDescriptor {
  return {
    adapterId,
    name: op.name,
    key: `${adapterId}:${op.name}`,
    title: op.title,
    description: op.description,
    kind: op.kind,
    permissions: op.permissions,
    recovery: op.recovery,
    timeoutMs: op.timeoutMs,
    inputJsonSchema: z.toJSONSchema(op.inputSchema),
  };
}

/**
 * Capability declarations must be internally consistent. Registration fails
 * loudly instead of letting an inconsistent adapter reach the engine.
 */
export function validateAdapter(adapter: Adapter): void {
  const problems: string[] = [];
  const names = new Set<string>();
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(adapter.id)) problems.push(`adapter id "${adapter.id}" must be kebab-case`);
  for (const op of adapter.operations) {
    if (names.has(op.name)) problems.push(`duplicate operation "${op.name}"`);
    names.add(op.name);
    if (!/^[a-z][a-z0-9_.]{1,60}$/.test(op.name)) problems.push(`operation name "${op.name}" is invalid`);
    const cap = op.recovery.capability;
    if (op.kind === 'read' && cap !== 'none') problems.push(`${op.name}: reads must declare capability "none"`);
    if (op.kind === 'mutation' && cap === 'none') problems.push(`${op.name}: mutations must declare a recovery capability`);
    if ((cap === 'compensatable' || cap === 'rollback') && !op.compensate) {
      problems.push(`${op.name}: declares "${cap}" but registers no compensation handler`);
    }
    if (cap === 'irreversible' && op.compensate) problems.push(`${op.name}: irreversible operations must not register compensation`);
    if (op.timeoutMs <= 0 || op.timeoutMs > 60_000) problems.push(`${op.name}: timeoutMs must be between 1 and 60000`);
  }
  if (problems.length) throw new Error(`Adapter "${adapter.id}" failed validation: ${problems.join('; ')}`);
}
