import { Link } from 'react-router';
import { CodeBlock, Section, useAsync } from '../../components/ui';
import { api } from '../../lib/api';

const ENV: [string, string, string][] = [
  ['REWIND_HOST', '127.0.0.1', 'Bind address. A non-loopback value requires REWIND_ALLOWED_HOSTS.'],
  ['REWIND_PORT', '4747', 'Port for the console, API and MCP endpoint.'],
  ['REWIND_PUBLIC_URL', 'http://host:port', 'Base URL used in invitation and password-reset links.'],
  ['REWIND_DB_PATH', './data/rewind.db', 'SQLite database file. Created and migrated on start.'],
  ['REWIND_ENVIRONMENT', 'local-demo', 'Label recorded on every execution.'],
  ['REWIND_ALLOWED_HOSTS', '(unset)', 'Hostnames accepted in Host/Origin when binding beyond loopback.'],
  ['REWIND_COOKIE_SECURE', 'auto', 'Secure session cookies: auto (when HTTPS), true or false.'],
  ['REWIND_TRUST_UPSTREAM_AUTH', 'none', 'agentcore: accept MCP calls already authenticated by Amazon Bedrock AgentCore.'],
  ['REWIND_METRICS_TOKEN', '(unset)', 'Bearer token for /metrics when not on loopback.'],
  ['REWIND_ALLOW_PRIVATE_WEBHOOKS', 'loopback: true', 'Allow webhook targets on private addresses (development only).'],
  ['REWIND_RESEND_API_KEY', '(unset)', 'Resend API key (re_…). When set, invitations, password resets and security alerts are emailed.'],
  ['REWIND_MAIL_FROM', 'REWIND <onboarding@resend.dev>', 'Sender. Use an address on a domain verified in Resend.'],
  ['REWIND_SSO_GOOGLE_CLIENT_ID / _SECRET', '(unset)', 'Enable Sign in with Google. Redirect URI: <public URL>/api/auth/sso/google/callback'],
  ['REWIND_SSO_MICROSOFT_CLIENT_ID / _SECRET / _TENANT', '(unset)', 'Enable Sign in with Microsoft (Entra ID). Tenant defaults to common.'],
  ['REWIND_SSO_OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET / _NAME', '(unset)', 'Any OpenID Connect provider: Okta, Auth0, Keycloak, Cognito…'],
  ['REWIND_SECRET_KEY', '(generated)', 'Base64 32-byte key encrypting MFA secrets at rest. Generated next to the database if unset.'],
  ['REWIND_RETENTION_DAYS', '30', 'Finished executions older than this are purged hourly.'],
  ['REWIND_GUEST_RETENTION_HOURS', '48', 'Guest workspaces are deleted after this many hours.'],
  ['REWIND_LOG_LEVEL', 'info', 'debug | info | warn | error | silent. JSON lines with redaction.'],
];

export function ConnectSettings() {
  const s = useAsync(() => api.settings(), []).data;
  const url = `${window.location.origin}/mcp`;
  return (
    <div className="space-y-6">
      <Section title="Connect an MCP client" description="Streamable HTTP, stateless, official MCP TypeScript SDK v2. The client negotiates protocol 2025-11-25.">
        <p className="border-b border-border px-4 py-3 text-sm text-fg-2">
          You need a workspace API key.{' '}
          <Link to="/app/settings/keys" className="font-medium text-accent hover:underline">
            Create one
          </Link>{' '}
          (admins), then use it below.
        </p>
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
          <CodeBlock label="Claude Code" code={`claude mcp add --transport http rewind ${url} \\\n  --header "Authorization: Bearer $REWIND_API_KEY"`} />
          <CodeBlock label="Generic client config (JSON)" code={`{\n  "mcpServers": {\n    "rewind": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer \${REWIND_API_KEY}" }\n    }\n  }\n}`} />
          <CodeBlock label="MCP Inspector" code={`npx @modelcontextprotocol/inspector\n# Transport: Streamable HTTP   URL: ${url}\n# Header: Authorization: Bearer <your key>`} />
          <CodeBlock label="Scripted client (from the repo)" code={'REWIND_API_KEY=rwk_… npm run demo:mcp'} />
        </div>
        {s && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border px-4 py-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-fg-3">Endpoint</dt>
              <dd className="font-mono">{url}</dd>
            </div>
            <div>
              <dt className="text-fg-3">MCP auth</dt>
              <dd>{s.auth.mcp}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Protocol versions accepted</dt>
              <dd className="font-mono">{s.mcp.protocolVersions.join(', ')}</dd>
            </div>
          </dl>
        )}
      </Section>

      <Section title="Tools exposed" description="Strict inputs, bounded outputs. Approvals, policy edits, fault injection and resets stay with people.">
        <ul className="grid grid-cols-1 gap-px bg-border text-sm sm:grid-cols-2">
          {[
            ['list_operations', 'Registered operations, schemas, recovery capability, current policy decision'],
            ['create_execution', 'Open an execution (idempotency key, optional plan)'],
            ['execute_registered_action', 'Run one registered operation after policy checks'],
            ['run_execution', 'Advance a pre-declared plan'],
            ['complete_execution', 'Close an agent-driven execution'],
            ['get_execution', 'Status, steps, recovery summary'],
            ['list_executions', 'Bounded, filtered, cursor-paginated history'],
            ['get_execution_trace', 'Ordered audit timeline'],
            ['request_recovery', 'Idempotent recovery request'],
            ['get_recovery_status', 'Per-step outcomes, verification, unresolved effects'],
            ['get_resource_state', 'Read a resource through a registered read operation'],
          ].map(([n, d]) => (
            <li key={n} className="bg-surface px-4 py-2.5">
              <code className="font-mono text-xs font-medium">{n}</code>
              <p className="text-xs text-fg-2">{d}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Operations endpoints">
        <ul className="divide-y divide-border text-sm">
          {[
            ['/healthz', 'Liveness: the process is up.'],
            ['/readyz', 'Readiness: the database answers.'],
            ['/metrics', 'Prometheus metrics. Open on loopback; requires REWIND_METRICS_TOKEN otherwise.'],
            ['/api/health', 'Detailed health including adapter checks.'],
          ].map(([p, d]) => (
            <li key={p} className="flex gap-3 px-4 py-2.5">
              <code className="w-28 shrink-0 font-mono text-xs">{p}</code>
              <span className="text-xs text-fg-2">{d}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Environment variables" description="Set in the shell or a .env file. Secret values are never rendered.">
        <ul className="divide-y divide-border text-xs">
          {ENV.map(([k, d, p]) => (
            <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-2">
              <code className="font-mono font-medium">{k}</code>
              <code className="font-mono text-fg-3">{d}</code>
              <p className="col-span-2 text-fg-2">{p}</p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
