import { z } from 'zod/v4';
import { ssoProvidersFromEnv, type SsoProviderConfig } from './services/sso.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

const schema = z.object({
  REWIND_HOST: z.string().default('127.0.0.1'),
  REWIND_PORT: z.coerce.number().int().min(1).max(65535).default(4747),
  REWIND_DB_PATH: z.string().default('./data/rewind.db'),
  REWIND_ENVIRONMENT: z.string().regex(/^[a-z0-9-]{1,32}$/).default('local-demo'),
  REWIND_ALLOWED_HOSTS: z.string().optional(),
  REWIND_COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),
  REWIND_TRUST_UPSTREAM_AUTH: z.enum(['none', 'agentcore']).default('none'),
  REWIND_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  REWIND_GUEST_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  REWIND_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  REWIND_DEMO_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(1500),
  REWIND_PUBLIC_URL: z.string().url().optional(),
  REWIND_METRICS_TOKEN: z.string().min(16).optional(),
  REWIND_ALLOW_PRIVATE_WEBHOOKS: z.enum(['true', 'false']).optional(),
  REWIND_RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, 'Resend API keys start with re_').optional(),
  REWIND_MAIL_FROM: z.string().min(3).default('REWIND <onboarding@resend.dev>'),
  REWIND_TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  REWIND_SECRET_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'REWIND_SECRET_KEY must be 32 bytes, base64-encoded').optional(),
});

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  environment: string;
  allowedHosts: string[];
  cookieSecure: 'true' | 'false' | 'auto';
  /**
   * "agentcore": MCP requests without credentials are accepted and mapped to the
   * built-in workspace, because Amazon Bedrock AgentCore Runtime has already
   * authenticated the caller (SigV4 or JWT) before the request reaches the container.
   * Never enable this on a server reachable any other way.
   */
  trustUpstreamAuth: 'none' | 'agentcore';
  retentionDays: number;
  guestRetentionHours: number;
  logLevel: z.infer<typeof schema>['REWIND_LOG_LEVEL'];
  demoTimeoutMs: number;
  localOnly: boolean;
  /** Base URL used in invitation and password-reset links. */
  publicUrl: string;
  /** Bearer token for /metrics when not bound to loopback. */
  metricsToken: string | null;
  /** Allow webhook targets on private/loopback addresses (development only). Defaults to true on loopback binds. */
  allowPrivateWebhooks: boolean;
  /** Resend API key; when set, email is delivered through Resend. */
  resendApiKey: string | null;
  mailFrom: string;
  /** Key for encrypting secrets at rest (MFA seeds). Generated next to the database when unset. */
  secretKey: string | null;
  /** Reverse-proxy hops in front of the server (Render: 1). 0 trusts no forwarding headers. */
  trustProxy: number;
  ssoProviders: SsoProviderConfig[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Platform defaults (Render): its port, public URL and hostname, unless set explicitly.
  env = {
    ...env,
    REWIND_PORT: env.REWIND_PORT ?? env.PORT,
    REWIND_PUBLIC_URL: env.REWIND_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL,
    REWIND_ALLOWED_HOSTS: env.REWIND_ALLOWED_HOSTS ?? env.RENDER_EXTERNAL_HOSTNAME,
  };
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  const localOnly = LOCAL_HOSTS.includes(c.REWIND_HOST);
  const allowedHosts = c.REWIND_ALLOWED_HOSTS ? c.REWIND_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!localOnly && allowedHosts.length === 0) {
    throw new Error(`REWIND_HOST=${c.REWIND_HOST} exposes the server beyond loopback. Set REWIND_ALLOWED_HOSTS to the hostnames clients use, so Host/Origin validation stays on.`);
  }
  return {
    host: c.REWIND_HOST,
    port: c.REWIND_PORT,
    dbPath: c.REWIND_DB_PATH,
    environment: c.REWIND_ENVIRONMENT,
    allowedHosts,
    cookieSecure: c.REWIND_COOKIE_SECURE,
    trustUpstreamAuth: c.REWIND_TRUST_UPSTREAM_AUTH,
    retentionDays: c.REWIND_RETENTION_DAYS,
    guestRetentionHours: c.REWIND_GUEST_RETENTION_HOURS,
    logLevel: c.REWIND_LOG_LEVEL,
    demoTimeoutMs: c.REWIND_DEMO_TIMEOUT_MS,
    localOnly,
    publicUrl: (c.REWIND_PUBLIC_URL ?? `http://${c.REWIND_HOST === '::1' ? '[::1]' : c.REWIND_HOST}:${c.REWIND_PORT}`).replace(/\/$/, ''),
    metricsToken: c.REWIND_METRICS_TOKEN ?? null,
    allowPrivateWebhooks: c.REWIND_ALLOW_PRIVATE_WEBHOOKS ? c.REWIND_ALLOW_PRIVATE_WEBHOOKS === 'true' : localOnly,
    resendApiKey: c.REWIND_RESEND_API_KEY ?? null,
    mailFrom: c.REWIND_MAIL_FROM,
    secretKey: c.REWIND_SECRET_KEY ?? null,
    trustProxy: c.REWIND_TRUST_PROXY,
    ssoProviders: ssoProvidersFromEnv(env),
  };
}
