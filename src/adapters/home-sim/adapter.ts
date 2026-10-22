/**
 * home-sim: a deterministic, local, synthetic smart-home adapter.
 *
 * It controls no real device. It exists so the full forward, failure,
 * compensation and verification path can be exercised end to end against
 * persisted state, with faults injected on purpose rather than by luck.
 */
import { z } from 'zod/v4';
import { AdapterError } from '../../domain/errors.js';
import { nowIso, sleep } from '../../domain/util.js';
import type { Adapter, OperationDefinition, ResourceRef, ResourceState } from '../types.js';
import { HomeSimStore } from './store.js';

export const HOME_SIM_ID = 'home-sim';

type Data = Record<string, unknown>;

interface MutationSpec<I> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  permissions: string[];
  resource: ResourceRef;
  apply(current: Data, input: I): Data;
  capability: 'compensatable' | 'irreversible';
  recoverySummary: string;
  /** How another household member changes this resource in a "drift" fault. */
  drift?(data: Data): Data;
  failure: { code: string; message: string };
  timeoutMs?: number;
}

export function createHomeSimAdapter(store: HomeSimStore, opts: { timeoutMs?: number } = {}): Adapter {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const read = async (ref: ResourceRef, ctx: { workspaceId: string }) => store.read(ctx.workspaceId, ref.type, ref.id);

  const readOp = (name: string, title: string, ref: ResourceRef): OperationDefinition<Record<string, never>> => ({
    name,
    title,
    description: `Read the current ${ref.type} state.`,
    kind: 'read',
    inputSchema: z.object({}).strict(),
    permissions: [`home.${ref.type}.read`],
    recovery: { capability: 'none', idempotentCompensation: true, summary: 'Read-only; nothing to recover.' },
    timeoutMs,
    resource: () => ref,
    read,
    async execute(_input, ctx) {
      return store.read(ctx.workspaceId, ref.type, ref.id);
    },
  });

  function mutation<I>(spec: MutationSpec<I>): OperationDefinition<I> {
    const ref = spec.resource;
    const op: OperationDefinition<I> = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      kind: 'mutation',
      inputSchema: spec.inputSchema,
      permissions: spec.permissions,
      recovery: {
        capability: spec.capability,
        idempotentCompensation: spec.capability === 'compensatable',
        summary: spec.recoverySummary,
      },
      timeoutMs: spec.timeoutMs ?? timeoutMs,
      resource: () => ref,
      read,
      expectedAfter: (before, input) => spec.apply(before.data, input),
      writtenVersion: (result) => (result as { version?: number } | null)?.version,
      async execute(input, ctx) {
        const ws = ctx.workspaceId;
        const fault = store.takeFault(ws, spec.name, ['error', 'transient', 'timeout', 'drift']);
        if (fault === 'error') throw new AdapterError(spec.failure.code, spec.failure.message, 'none');
        if (fault === 'transient') {
          throw new AdapterError('TEMPORARILY_UNAVAILABLE', `${spec.title}: the simulated hub was briefly unavailable. Nothing was changed.`, 'none', true);
        }
        const current = store.read(ws, ref.type, ref.id);
        const next = spec.apply(current.data, input);
        const written = store.write(ws, ref.type, ref.id, current.version, next, `rewind:${ctx.executionId}`);
        if (fault === 'timeout') {
          // The write landed but the response is lost: the engine must treat the outcome as unknown.
          await sleep(op.timeoutMs * 4, ctx.signal);
        }
        if (fault === 'drift' && spec.drift) {
          // Someone else changes the resource after Rewind did, before any recovery runs.
          store.write(ws, ref.type, ref.id, written.version, spec.drift(next), 'external:household-member');
        }
        return { resource: `${ref.type}/${ref.id}`, version: written.version, state: next };
      },
    };
    if (spec.capability === 'compensatable') {
      op.compensate = async ({ workspaceId: ws, before, after, writtenVersion }) => {
        if (store.takeFault(ws, spec.name, ['compensation_error'])) {
          throw new AdapterError('COMPENSATION_REJECTED', `${spec.title}: the simulated hub rejected the restore request. Nothing was changed.`, 'none');
        }
        const current = store.read(ws, ref.type, ref.id);
        const expected = writtenVersion ?? after?.version;
        if (expected !== undefined && current.version !== expected) {
          throw new AdapterError('STATE_CONFLICT', `${ref.type}/${ref.id} changed after Rewind wrote it (v${expected} → v${current.version}).`, 'none');
        }
        const silent = store.takeFault(ws, spec.name, ['silent_compensation_failure']);
        // A buggy handler that reports success but writes the wrong thing. Verification must catch this.
        const target = silent ? spec.apply(before.data, undefined as never) : before.data;
        store.write(ws, ref.type, ref.id, current.version, target, 'rewind:compensation');
      };
    }
    return op;
  }

  const thermostat: ResourceRef = { type: 'thermostat', id: 'main' };
  const tasks: ResourceRef = { type: 'tasks', id: 'household' };
  const security: ResourceRef = { type: 'security', id: 'routine' };
  const outbox: ResourceRef = { type: 'notifications', id: 'outbox' };

  const operations: OperationDefinition[] = [
    readOp('thermostat.read', 'Read thermostat', thermostat),
    mutation({
      name: 'thermostat.set_mode',
      title: 'Set thermostat mode',
      description: 'Change the simulated thermostat mode and optional target temperature.',
      inputSchema: z.object({ mode: z.enum(['home', 'away', 'eco', 'off']), targetC: z.number().min(5).max(30).optional() }).strict(),
      permissions: ['home.thermostat.write'],
      resource: thermostat,
      capability: 'compensatable',
      recoverySummary: 'Compensation writes back the captured mode and target, only if nobody changed the thermostat since.',
      apply: (cur, input) => ({ ...cur, mode: input?.mode ?? 'away', targetC: input?.targetC ?? (input ? cur.targetC : 16) }),
      drift: (d) => ({ ...d, targetC: 18 }),
      failure: { code: 'THERMOSTAT_UNREACHABLE', message: 'The simulated thermostat did not respond. Nothing was changed.' },
    }),
    readOp('tasks.read', 'Read household tasks', tasks),
    mutation({
      name: 'tasks.update',
      title: 'Update household tasks',
      description: 'Add tasks and/or mark tasks done on the simulated household list.',
      inputSchema: z
        .object({
          add: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
          complete: z.array(z.string().regex(/^t\d{1,4}$/)).max(20).optional(),
        })
        .strict()
        .refine((v) => (v.add?.length ?? 0) + (v.complete?.length ?? 0) > 0, 'Provide at least one task to add or complete.'),
      permissions: ['home.tasks.write'],
      resource: tasks,
      capability: 'compensatable',
      recoverySummary: 'Compensation restores the captured task list, only if nobody edited the list since.',
      apply: (cur, input) => {
        const items = [...((cur.items as { id: string; title: string; done: boolean }[]) ?? [])].map((i) => ({ ...i }));
        const add = input?.add ?? ['(corrupted by faulty handler)'];
        let n = items.reduce((m, i) => Math.max(m, Number(i.id.slice(1)) || 0), 0);
        for (const title of add) items.push({ id: `t${++n}`, title, done: false });
        for (const id of input?.complete ?? []) {
          const item = items.find((i) => i.id === id);
          if (item) item.done = true;
        }
        return { ...cur, items };
      },
      drift: (d) => ({ ...d, items: [...(d.items as unknown[]), { id: 't99', title: 'Buy milk (added by another household member)', done: false }] }),
      failure: { code: 'TASKS_UNAVAILABLE', message: 'The simulated task service is unavailable. Nothing was changed.' },
    }),
    readOp('security.read', 'Read security routine', security),
    mutation({
      name: 'security.activate_routine',
      title: 'Activate security routine',
      description: 'Activate the simulated weekend-away security routine.',
      inputSchema: z.object({ routine: z.literal('weekend-away') }).strict(),
      permissions: ['home.security.write'],
      resource: security,
      capability: 'compensatable',
      recoverySummary: 'Compensation deactivates the routine, only if nobody changed it since.',
      apply: (cur) => ({ ...cur, state: 'active', activatedAt: 'set-by-routine' }),
      failure: { code: 'SECURITY_HUB_REJECTED', message: 'The simulated security hub rejected the activation. The routine was not activated.' },
    }),
    mutation({
      name: 'security.disarm',
      title: 'Disarm security',
      description: 'Disarm the simulated security routine. Prohibited by the default policy.',
      inputSchema: z.object({ reason: z.string().min(3).max(200) }).strict(),
      permissions: ['home.security.admin'],
      resource: security,
      capability: 'compensatable',
      recoverySummary: 'Compensation re-applies the captured security state.',
      apply: (cur) => ({ ...cur, state: 'disarmed' }),
      failure: { code: 'SECURITY_HUB_REJECTED', message: 'The simulated security hub rejected the request.' },
    }),
    mutation({
      name: 'notify.send_message',
      title: 'Send household message',
      description: 'Send a message to the household. A sent message cannot be unsent.',
      inputSchema: z.object({ text: z.string().trim().min(1).max(280) }).strict(),
      permissions: ['home.notify.send'],
      resource: outbox,
      capability: 'irreversible',
      recoverySummary: 'Irreversible: once delivered, a message cannot be recalled. Rewind reports it as an unresolved side effect.',
      apply: (cur, input) => ({ ...cur, sent: [...((cur.sent as unknown[]) ?? []), { text: input?.text ?? '', channel: 'household' }] }),
      failure: { code: 'NOTIFY_FAILED', message: 'The simulated messaging service rejected the message. Nothing was sent.' },
    }),
  ];

  return {
    id: HOME_SIM_ID,
    name: 'Home simulation',
    type: 'local-simulation',
    version: '1.0.0',
    description: 'Synthetic thermostat, task list, security routine and household messaging, persisted per workspace in the local database.',
    disclosure: 'Simulated. Controls no real device, account or home. All data is synthetic demo data.',
    operations,
    async health() {
      try {
        const workspaces = store.ping();
        return { status: 'healthy', checkedAt: nowIso(), detail: `Backing tables readable; ${workspaces} workspace home(s) seeded.` };
      } catch (error) {
        return { status: 'unavailable', checkedAt: nowIso(), detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export type { ResourceState };
