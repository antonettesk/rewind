/**
 * MCP tool definitions. Each tool is a thin, strictly validated adapter over
 * the same application services the HTTP API uses; none contains business
 * logic of its own. There is deliberately no tool to approve an action, edit a
 * policy, reset the demo or arm a fault: those are human controls.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { DomainError } from '../domain/errors.js';
import { evaluateActionPolicy } from '../domain/policy.js';
import { redact } from '../domain/redact.js';
import { EXECUTION_STATUSES } from '../domain/status.js';
import type { CallContext } from '../engine/engine.js';
import type { App } from '../services/app.js';
import type { ExecutionView } from '../services/queries.js';

export const SERVER_INFO = { name: 'rewind', version: '0.1.0' };
const MAX_TEXT = 60_000;

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{20}$`), `Expected a ${prefix}_… identifier`);
const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Letters, digits and . _ : - only');
const adapterId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const operationName = z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/);
const stepSchema = z
  .object({
    adapter_id: adapterId,
    operation: operationName,
    input: z.record(z.string(), z.unknown()).default({}),
    depends_on: z.array(z.number().int().min(1)).max(20).optional().describe('1-based step numbers this step depends on. Omit to depend on the previous step; [] for independent.'),
    dedupe_key: key.optional(),
  })
  .strict();

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  const safe = redact(data) as Record<string, unknown>;
  let text = JSON.stringify(safe, null, 2);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… [truncated; use narrower queries]`;
  return { content: [{ type: 'text', text }], structuredContent: safe };
}

function fail(error: unknown): ToolResult {
  const body =
    error instanceof DomainError
      ? { error: { code: error.code, message: error.message, details: redact(error.details) } }
      : { error: { code: 'INTERNAL', message: 'An internal error occurred. It has been logged.' } };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true };
}

async function guard(app: App, tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  try {
    const r = await fn();
    app.log.info('mcp.tool_call', { tool, ok: true, ms: Date.now() - started });
    return r;
  } catch (error) {
    app.log[error instanceof DomainError ? 'info' : 'error']('mcp.tool_call', {
      tool,
      ok: false,
      ms: Date.now() - started,
      code: error instanceof DomainError ? error.code : 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    });
    return fail(error);
  }
}

function compactView(v: ExecutionView) {
  return {
    execution: {
      id: v.execution.id,
      status: v.execution.status,
      task: v.execution.taskDescription,
      failureReason: v.execution.failureReason,
      createdAt: v.execution.createdAt,
      completedAt: v.execution.completedAt,
      environment: v.execution.environment,
    },
    summary: v.summary,
    actions: v.actions.map((a) => ({
      id: a.id,
      step: a.sequence,
      operation: a.operationKey,
      status: a.status,
      policy: a.policy.decision,
      capability: a.capability,
      error: a.errorCode ? { code: a.errorCode, message: a.errorMessage, effect: a.errorEffect } : null,
      recovery: { outcome: a.recoveryOutcome, reason: a.recoveryOutcomeReason, attempts: a.recoveryAttempts.length },
    })),
  };
}

export function buildMcpServer(app: App, ctx: CallContext, opts: { readOnly?: boolean } = {}): McpServer {
  const writable = () => {
    if (opts.readOnly) throw new DomainError('FORBIDDEN', 'Viewers have read-only access to this workspace.');
  };
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'REWIND records, executes and recovers multi-step tool actions. Discover operations with list_operations, open an execution with create_execution, ' +
      'then call execute_registered_action for each step. If a step fails, REWIND halts and runs registered compensations automatically when policy allows; ' +
      'read the outcome with get_recovery_status. Never assume an action was undone unless its recovery outcome is "recovery_verified". ' +
      'Approvals are granted by people in the REWIND console, not through MCP.',
  });

  server.registerTool(
    'list_operations',
    {
      title: 'List registered operations',
      description: 'List every operation REWIND can execute, with its input schema, declared recovery capability, permissions, and the current policy decision.',
      inputSchema: z.object({ adapter_id: adapterId.optional() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ adapter_id }) =>
      guard(app, 'list_operations', async () => {
        const policies = await app.repo.listPolicies(ctx.workspaceId);
        const ops = app.registry
          .describe()
          .filter((o) => !adapter_id || o.adapterId === adapter_id)
          .map((o) => ({ ...o, policy: evaluateActionPolicy(policies, o.key, o.kind).decision }));
        return ok({ operations: ops, adapters: app.registry.list().map((a) => ({ id: a.id, name: a.name, type: a.type, disclosure: a.disclosure })) });
      }),
  );

  server.registerTool(
    'create_execution',
    {
      title: 'Create execution',
      description:
        'Open a new execution for a user request. Optionally pre-declare a plan of steps (validated now, run with run_execution). ' +
        'Reusing an idempotency_key with the same request returns the original execution instead of creating a duplicate.',
      inputSchema: z
        .object({
          task_description: z.string().trim().min(3).max(500),
          idempotency_key: key.optional(),
          plan: z.array(stepSchema).max(20).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_description, idempotency_key, plan }) =>
      guard(app, 'create_execution', async () => {
        writable();
        const { execution, created } = await app.engine.createExecution(ctx, {
          taskDescription: task_description,
          idempotencyKey: idempotency_key,
          source: 'mcp',
          plan: plan?.map((s) => ({ adapterId: s.adapter_id, operation: s.operation, input: s.input, dependsOn: s.depends_on, dedupeKey: s.dedupe_key })),
        });
        const view = await app.queries.executionView(ctx.workspaceId, execution.id);
        return ok({ created, ...compactView(view) });
      }),
  );

  server.registerTool(
    'execute_registered_action',
    {
      title: 'Execute a registered action',
      description:
        'Run one registered adapter operation as the next step of an open execution. REWIND checks policy, captures the resource state, executes with a timeout, and records the result. ' +
        'On failure it halts the execution and, if policy allows, compensates earlier steps and verifies them. Pass a dedupe_key so a retried call never repeats the mutation.',
      inputSchema: z
        .object({
          execution_id: id('exe'),
          adapter_id: adapterId,
          operation: operationName,
          input: z.record(z.string(), z.unknown()).default({}),
          depends_on: z.array(z.number().int().min(1)).max(20).optional(),
          dedupe_key: key.optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(app, 'execute_registered_action', async () => {
        writable();
        const { action, deduplicated } = await app.engine.executeAction(ctx, args.execution_id, {
          adapterId: args.adapter_id,
          operation: args.operation,
          input: args.input,
          dependsOn: args.depends_on,
          dedupeKey: args.dedupe_key,
        });
        const view = await app.queries.executionView(ctx.workspaceId, args.execution_id);
        const step = view.actions.find((a) => a.id === action.id)!;
        const result = {
          deduplicated,
          step: {
            id: step.id,
            step: step.sequence,
            operation: step.operationKey,
            status: step.status,
            policy: step.policy,
            result: step.result,
            error: step.errorCode ? { code: step.errorCode, message: step.errorMessage, effect: step.errorEffect } : null,
          },
          ...compactView(view),
        };
        // A failed step is a tool-level error so agents notice it, with the full recovery picture attached.
        if (step.status !== 'succeeded') return { ...ok(result), isError: true };
        return ok(result);
      }),
  );

  server.registerTool(
    'run_execution',
    {
      title: 'Run a planned execution',
      description: 'Run the remaining pre-declared steps of an execution in order. Stops at approval gates and at the first failure (then recovers per policy).',
      inputSchema: z.object({ execution_id: id('exe') }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ execution_id }) =>
      guard(app, 'run_execution', async () => {
        writable();
        await app.engine.runPlan(ctx, execution_id);
        return ok(compactView(await app.queries.executionView(ctx.workspaceId, execution_id)));
      }),
  );

  server.registerTool(
    'complete_execution',
    {
      title: 'Complete execution',
      description: 'Mark an agent-driven execution as finished after all its steps succeeded.',
      inputSchema: z.object({ execution_id: id('exe') }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ execution_id }) =>
      guard(app, 'complete_execution', async () => {
        writable();
        await app.engine.completeExecution(ctx, execution_id);
        return ok(compactView(await app.queries.executionView(ctx.workspaceId, execution_id)));
      }),
  );

  server.registerTool(
    'get_execution',
    {
      title: 'Get execution',
      description: 'Current status, steps and recovery summary for one execution.',
      inputSchema: z.object({ execution_id: id('exe') }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ execution_id }) => guard(app, 'get_execution', async () => ok(compactView(await app.queries.executionView(ctx.workspaceId, execution_id)))),
  );

  server.registerTool(
    'list_executions',
    {
      title: 'List executions',
      description: 'Recent executions, newest first, with optional status filter and text search. Paginated with an opaque cursor.',
      inputSchema: z
        .object({
          status: z.array(z.enum(EXECUTION_STATUSES)).max(10).optional(),
          search: z.string().max(100).optional(),
          limit: z.number().int().min(1).max(50).default(10),
          cursor: z.string().max(200).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(app, 'list_executions', async () => {
        const { items, nextCursor } = await app.repo.listExecutions({ workspaceId: ctx.workspaceId, status: args.status, search: args.search, limit: args.limit, cursor: args.cursor });
        return ok({
          executions: items.map((e) => ({ id: e.id, status: e.status, task: e.taskDescription, createdAt: e.createdAt, completedAt: e.completedAt, failureReason: e.failureReason })),
          nextCursor,
        });
      }),
  );

  server.registerTool(
    'get_execution_trace',
    {
      title: 'Get execution trace',
      description: 'The recorded timeline of an execution: policy decisions, snapshots, actions, failures, retries, compensations and verifications, in order.',
      inputSchema: z.object({ execution_id: id('exe'), max_events: z.number().int().min(1).max(500).default(200) }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ execution_id, max_events }) =>
      guard(app, 'get_execution_trace', async () => {
        const view = await app.queries.executionView(ctx.workspaceId, execution_id, { maxEvents: max_events });
        return ok({
          ...compactView(view),
          events: view.events.map((e) => ({ seq: e.seq, type: e.eventType, at: e.timestamp, actor: e.actorType, payload: e.payload })),
          truncated: view.eventsTruncated,
        });
      }),
  );

  server.registerTool(
    'request_recovery',
    {
      title: 'Request recovery',
      description:
        'Ask REWIND to recover a failed, cancelled or partially recovered execution. REWIND decides deterministically which steps are eligible from their registered capabilities; ' +
        'a request_key makes the request idempotent. Irreversible effects are reported, never "undone".',
      inputSchema: z.object({ execution_id: id('exe'), request_key: key }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ execution_id, request_key }) =>
      guard(app, 'request_recovery', async () => {
        writable();
        await app.engine.recover(ctx, execution_id, { requestKey: request_key });
        return ok(compactView(await app.queries.executionView(ctx.workspaceId, execution_id)));
      }),
  );

  server.registerTool(
    'get_recovery_status',
    {
      title: 'Get recovery status',
      description: 'Recovery requests, per-step outcomes, verification results and unresolved side effects for one execution.',
      inputSchema: z.object({ execution_id: id('exe') }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ execution_id }) =>
      guard(app, 'get_recovery_status', async () => {
        const v = await app.queries.executionView(ctx.workspaceId, execution_id);
        return ok({
          executionId: v.execution.id,
          status: v.execution.status,
          recoveryStatus: v.summary.recoveryStatus,
          unresolvedSideEffects: v.summary.unresolved,
          retry: v.summary.retry,
          requests: v.recoveryRequests.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, outcome: r.outcome, plan: r.plan, createdAt: r.createdAt })),
          steps: v.actions.map((a) => ({
            step: a.sequence,
            operation: a.operationKey,
            actionStatus: a.status,
            outcome: a.recoveryOutcome,
            reason: a.recoveryOutcomeReason,
            attempts: a.recoveryAttempts.map((t) => ({ attempt: t.attemptNumber, status: t.status, error: t.errorCode, verification: t.verification })),
          })),
        });
      }),
  );

  server.registerTool(
    'get_resource_state',
    {
      title: 'Get resource state',
      description: 'Read the current state of a resource that a registered read operation exposes (for example home-sim thermostat/main).',
      inputSchema: z
        .object({ adapter_id: adapterId, resource_type: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/), resource_id: z.string().regex(/^[a-z0-9_-]{1,64}$/) })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ adapter_id, resource_type, resource_id }) =>
      guard(app, 'get_resource_state', async () => {
        const adapter = app.registry.getAdapter(adapter_id);
        const policies = await app.repo.listPolicies(ctx.workspaceId);
        // Only resources reachable through a registered, policy-allowed read operation.
        const readOp = adapter.operations.find((o) => {
          if (o.kind !== 'read') return false;
          const ref = o.resource({} as never);
          return ref.type === resource_type && ref.id === resource_id;
        });
        if (!readOp) throw new DomainError('NOT_FOUND', `No registered read operation exposes ${resource_type}/${resource_id} on ${adapter_id}.`);
        const decision = evaluateActionPolicy(policies, `${adapter_id}:${readOp.name}`, 'read');
        if (decision.decision === 'deny') throw new DomainError('POLICY_DENIED', decision.reason);
        const state = await readOp.read({ type: resource_type, id: resource_id }, { workspaceId: ctx.workspaceId, signal: AbortSignal.timeout(readOp.timeoutMs) });
        return ok({ adapter: adapter_id, resource: `${resource_type}/${resource_id}`, via: readOp.name, version: state.version, state: state.data, disclosure: adapter.disclosure });
      }),
  );

  return server;
}
