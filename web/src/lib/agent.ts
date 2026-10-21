/**
 * Browser agent simulation.
 *
 * This is a real MCP client (the official SDK over Streamable HTTP) driven by a
 * deterministic, keyword-based planner. There is no language model and no
 * Alexa+ connection: the "voice request" is typed text. Every effect happens on
 * the server through MCP tool calls.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PlannedStep } from './planner';

export interface McpLogEntry {
  id: number;
  method: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  ms: number;
  at: string;
  note?: string;
}

export async function runAgent(opts: {
  request: string;
  plan: PlannedStep[];
  pacingMs: number;
  onLog: (e: McpLogEntry) => void;
  onExecution: (id: string) => void;
  /** Resume an execution that paused for approval: skip discovery and creation, start at this step. */
  resume?: { executionId: string; from: number };
  /** First log id, so entries from a resumed run never collide with earlier ones. */
  idBase?: number;
}): Promise<{ executionId: string; failed: boolean; pausedAt: number | null }> {
  let n = opts.idBase ?? 0;
  const log = (e: Omit<McpLogEntry, 'id' | 'at'>) => opts.onLog({ ...e, id: ++n, at: new Date().toISOString() });
  const pause = () => new Promise((r) => setTimeout(r, opts.pacingMs));

  const client = new Client({ name: 'rewind-browser-agent-sim', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin));
  let t = performance.now();
  await client.connect(transport);
  const proto = (transport as unknown as { protocolVersion?: string }).protocolVersion;
  log({ method: 'initialize', ms: Math.round(performance.now() - t), result: { server: client.getServerVersion(), protocolVersion: proto ?? 'negotiated' }, note: 'Streamable HTTP' });

  const call = async (tool: string, args: Record<string, unknown>) => {
    t = performance.now();
    const r = await client.callTool({ name: tool, arguments: args });
    const entry = { method: 'tools/call', tool, args, result: r.structuredContent ?? r.content, isError: Boolean(r.isError), ms: Math.round(performance.now() - t) };
    log(entry);
    return { data: r.structuredContent as Record<string, any>, isError: Boolean(r.isError) };
  };

  try {
    let executionId: string;
    if (opts.resume) {
      executionId = opts.resume.executionId;
      log({ method: 'resume', ms: 0, note: `approval granted; continuing from step ${opts.resume.from + 1}` });
    } else {
      t = performance.now();
      const tools = await client.listTools();
      log({ method: 'tools/list', ms: Math.round(performance.now() - t), result: tools.tools.map((x) => x.name) });
      await pause();

      await call('list_operations', { adapter_id: 'home-sim' });
      await pause();

      const created = await call('create_execution', { task_description: opts.request, idempotency_key: `agent-sim-${Date.now()}` });
      if (created.isError) throw new Error(created.data?.error?.message ?? 'create_execution failed');
      executionId = created.data.execution.id as string;
    }
    opts.onExecution(executionId);

    let failed = false;
    let pausedAt: number | null = null;
    for (const [index, step] of opts.plan.entries()) {
      if (opts.resume && index < opts.resume.from) continue;
      await pause();
      const r = await call('execute_registered_action', {
        execution_id: executionId,
        adapter_id: step.adapter_id,
        operation: step.operation,
        input: step.input,
        depends_on: step.depends_on,
        dedupe_key: step.dedupe_key,
      });
      // An approval gate is reported as a tool error so agents notice it; it is a pause, not a failure.
      if (r.data?.step?.status === 'awaiting_approval' || r.data?.execution?.status === 'awaiting_approval') {
        pausedAt = index;
        break;
      }
      if (r.isError) {
        failed = true;
        break;
      }
    }
    if (pausedAt !== null) return { executionId, failed, pausedAt };
    await pause();
    if (failed) await call('get_recovery_status', { execution_id: executionId });
    else {
      const status = await call('get_execution', { execution_id: executionId });
      if (status.data?.execution?.status === 'running') await call('complete_execution', { execution_id: executionId });
    }
    return { executionId, failed, pausedAt };
  } finally {
    await client.close().catch(() => undefined);
  }
}
