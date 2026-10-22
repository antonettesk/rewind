/**
 * Standalone MCP client demo. Connects to a running Rewind server over
 * Streamable HTTP with the official SDK, runs the weekend workflow step by step,
 * and prints what Rewind recorded and verified.
 *
 *   npm run start            # in one terminal
 *   npm run demo:mcp         # in another
 *
 * Requires a workspace API key (Settings → API keys in the console):
 *   REWIND_API_KEY=rwk_… npm run demo:mcp
 * Options: --url http://127.0.0.1:4747/mcp   --no-fault
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);
const url = new URL(args[args.indexOf('--url') + 1] && args.includes('--url') ? args[args.indexOf('--url') + 1]! : 'http://127.0.0.1:4747/mcp');
const injectFault = !args.includes('--no-fault');
const key = process.env.REWIND_API_KEY;
if (!key) {
  console.error('Set REWIND_API_KEY to a workspace API key (console → Settings → API keys), e.g.');
  console.error('  REWIND_API_KEY=rwk_… npm run demo:mcp');
  process.exit(1);
}
const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
const api = (path: string, init?: RequestInit) => fetch(new URL(`/api${path}`, url), { ...init, headers: { 'Content-Type': 'application/json', ...headers, ...(init?.headers ?? {}) } });

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (c: number) => (s: string) => `\x1b[${c}m${s}\x1b[0m`;
const green = color(32);
const red = color(31);
const yellow = color(33);

async function main() {
  console.log(bold('Rewind MCP client demo'), dim(`→ ${url.href}`));

  // Demo control (human-side, HTTP API): arm the deterministic fault. The agent does not know about it.
  await api('/demo/faults', { method: 'DELETE' });
  if (injectFault) {
    const r = await api('/demo/faults', { method: 'POST', body: JSON.stringify({ operation: 'security.activate_routine', mode: 'error' }) });
    if (!r.ok) throw new Error(`Could not arm fault: ${r.status} ${await r.text()}`);
    console.log(yellow('• Fault armed:'), 'security.activate_routine → error');
  }

  const client = new Client({ name: 'rewind-cli-demo', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(transport);
  console.log(green('✓ Connected'), dim(`server ${client.getServerVersion()?.name}@${client.getServerVersion()?.version}, protocol ${(transport as unknown as { protocolVersion?: string }).protocolVersion ?? 'negotiated'}`));

  const tools = await client.listTools();
  console.log(green(`✓ tools/list`), dim(tools.tools.map((t) => t.name).join(', ')));

  const call = async (name: string, a: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: a });
    return { data: r.structuredContent as Record<string, any>, isError: Boolean(r.isError) };
  };

  const created = await call('create_execution', { task_description: 'Prepare the house for the weekend (CLI demo)', idempotency_key: `cli-${Date.now()}` });
  const id = created.data.execution.id as string;
  console.log(green('✓ create_execution'), id);

  const steps = [
    { operation: 'thermostat.set_mode', input: { mode: 'away', targetC: 16 }, depends_on: [] },
    { operation: 'tasks.update', input: { add: ['Weekend away: check windows before leaving'], complete: ['t2'] }, depends_on: [] },
    { operation: 'security.activate_routine', input: { routine: 'weekend-away' }, depends_on: [1, 2] },
  ];
  for (const s of steps) {
    const r = await call('execute_registered_action', { execution_id: id, adapter_id: 'home-sim', ...s, dedupe_key: s.operation });
    const st = r.data.step;
    if (r.isError) {
      console.log(red(`✗ ${s.operation}`), `${st?.error?.code ?? r.data.error?.code}: ${st?.error?.message ?? r.data.error?.message}`);
      break;
    }
    console.log(green(`✓ ${s.operation}`), dim(JSON.stringify(st.result?.state ?? st.result)));
  }

  const status = await call('get_recovery_status', { execution_id: id });
  console.log(`\n${bold('Execution status:')} ${status.data.status}  ${dim(`(recovery: ${status.data.recoveryStatus})`)}`);
  for (const s of status.data.steps) {
    const tone = s.outcome === 'recovery_verified' ? green : s.outcome === 'not_required' ? dim : red;
    console.log(`  #${s.step} ${s.operation.padEnd(36)} ${tone(s.outcome.padEnd(22))} ${dim(s.reason)}`);
  }
  if (status.data.unresolvedSideEffects.length) console.log(red(`  ${status.data.unresolvedSideEffects.length} unresolved side effect(s)`));

  for (const r of ['thermostat/main', 'tasks/household', 'security/routine']) {
    const [resource_type, resource_id] = r.split('/');
    const s = await call('get_resource_state', { adapter_id: 'home-sim', resource_type, resource_id });
    console.log(dim(`  ${r.padEnd(18)} v${s.data.version} ${JSON.stringify(s.data.state)}`));
  }
  console.log(`\nInspect: ${new URL(`/app/executions/${id}`, url).href}`);
  await client.close();
}

main().catch((error) => {
  console.error(red('Demo failed:'), error instanceof Error ? error.message : error);
  console.error(dim('Is the server running? Start it with `npm run start`.'));
  process.exit(1);
});
