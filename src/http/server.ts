/**
 * HTTP surface: the JSON API used by the web console, the MCP Streamable HTTP
 * endpoint, and the built web assets. One process, one port.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { DomainError, httpStatusFor } from '../domain/errors.js';
import { evaluateActionPolicy, parsePolicyConfig } from '../domain/policy.js';
import type { Actor } from '../domain/records.js';
import { EXECUTION_STATUSES } from '../domain/status.js';
import type { CallContext } from '../engine/engine.js';
import { buildMcpServer, SERVER_INFO } from '../mcp/tools.js';
import type { App } from '../services/app.js';
import { LOCAL_WORKSPACE } from '../services/defaults.js';
import { spokenSummary } from '../services/aws.js';
import { renderReport } from '../services/report.js';
import { SESSION_COOKIE, type AuthContext } from '../services/accounts.js';
import { requireRole } from '../services/team.js';
import { ROLES, type Role } from '../persistence/teams.js';
import { WEBHOOK_EVENTS } from '../services/webhooks.js';

export const MCP_PATH = '/mcp';

declare module 'express-serve-static-core' {
  interface Request {
    rewind?: { workspaceId: string; authMode: 'session' | 'api_key' | 'upstream'; actorLabel: string; auth?: AuthContext };
  }
}

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
/**
 * The on-device speech worker (Whisper via Transformers.js) is the only script
 * that may compile WebAssembly, load its runtime from a blob: URL, and fetch
 * model weights from Hugging Face. A worker obeys the policy on its own
 * response, so the page's strict policy above is unchanged.
 */
const SPEECH_WORKER = /^\/assets\/whisper\.worker-[\w-]+\.js$/;
const SPEECH_WORKER_CSP =
  "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co; object-src 'none'; base-uri 'none'";

export function createHttpApp(app: App) {
  const { config } = app;
  // Host and Origin validation (DNS rebinding protection) for every route on loopback binds.
  const http = createMcpExpressApp({
    host: config.host,
    // REWIND_ALLOWED_HOSTS=* turns Host/Origin validation off. Only for a trusted front door such as AgentCore Runtime.
    ...(config.allowedHosts.length && !config.allowedHosts.includes('*') ? { allowedHosts: config.allowedHosts, allowedOrigins: config.allowedHosts } : {}),
  });
  http.disable('x-powered-by');
  http.locals.cookieSecure = config.cookieSecure;
  http.set('trust proxy', config.trustProxy);
  http.use(compression());
  http.use((req, res, next) => {
    const id = /^[A-Za-z0-9-]{8,64}$/.test(String(req.headers['x-request-id'] ?? '')) ? String(req.headers['x-request-id']) : randomUUID();
    res.setHeader('X-Request-Id', id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Microphone for this origin only: the agent demo takes spoken requests.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', SPEECH_WORKER.test(req.path) ? SPEECH_WORKER_CSP : PAGE_CSP);
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.path.startsWith('/api/') ? 'api' : req.path === MCP_PATH ? 'mcp' : req.path.startsWith('/assets/') ? 'assets' : 'page';
      app.metrics.httpRequests.inc({ route, method: req.method, status: String(res.statusCode) });
      app.metrics.httpDuration.observe({ route }, seconds);
      if (res.statusCode >= 500 || seconds > 2) app.log.warn('http.request', { id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(seconds * 1000) });
      else app.log.debug('http.request', { id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(seconds * 1000) });
    });
    next();
  });

  // ── Operations: liveness, readiness, metrics ──
  http.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  http.get('/readyz', async (_req, res) => {
    try {
      await app.repo.ping();
      res.json({ status: 'ready' });
    } catch (error) {
      res.status(503).json({ status: 'not_ready', reason: error instanceof Error ? error.message : String(error) });
    }
  });
  http.get('/metrics', async (req, res, next) => {
    const token = config.metricsToken;
    const header = req.headers.authorization ?? '';
    if (token ? header !== `Bearer ${token}` : !config.localOnly) return next(new DomainError('UNAUTHORIZED', 'Metrics require REWIND_METRICS_TOKEN off loopback.'));
    const db = app.db;
    const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM executions GROUP BY status').all() as { status: string; n: number }[];
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    res.type('text/plain; version=0.0.4').send(
      app.metrics.render([
        { name: 'rewind_executions', help: 'Stored executions by status.', samples: byStatus.map((r) => ({ labels: { status: r.status }, value: r.n })) },
        { name: 'rewind_workspaces', help: 'Workspaces.', samples: [{ value: count('SELECT COUNT(*) AS n FROM workspaces') }] },
        { name: 'rewind_active_sessions', help: 'Unexpired sessions.', samples: [{ value: count(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > '${new Date().toISOString()}'`) }] },
        { name: 'rewind_resource_locks', help: 'Resource leases currently held.', samples: [{ value: count('SELECT COUNT(*) AS n FROM resource_locks') }] },
      ]),
    );
  });

  const limiter = rateLimit({ windowMs: 60_000, max: 300 });
  /** Server-side role check. The console hides controls a role can't use; this is what actually enforces it. */
  const role = (min: Role) => (req: Request, _res: Response, next: NextFunction) => {
    const a = req.rewind?.auth;
    if (!a) return next(new DomainError('FORBIDDEN', 'This action needs a signed-in user.'));
    try {
      requireRole(a, min);
      next();
    } catch (error) {
      next(error);
    }
  };
  const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
  const auth = authenticate(app, { allowUpstream: false });
  const mcpAuth = authenticate(app, { allowUpstream: config.trustUpstreamAuth === 'agentcore' });

  // ── MCP: Streamable HTTP, stateless per request ──
  const mcpHandler = createMcpHandler(
    (rc) => {
      const workspaceId = (rc.authInfo?.extra?.workspaceId as string | undefined) ?? LOCAL_WORKSPACE.id;
      const label = (rc.authInfo?.extra?.actorLabel as string | undefined) ?? 'mcp-client';
      const readOnly = rc.authInfo?.extra?.role === 'viewer';
      return buildMcpServer(app, { workspaceId, actor: { type: 'mcp_client', label } }, { readOnly });
    },
    { onerror: (error) => app.log.warn('mcp.transport_error', { message: error.message }) },
  );
  const mcpNode = toNodeHandler(mcpHandler);
  http.all(MCP_PATH, limiter, mcpAuth, (req, res) => {
    const { workspaceId, actorLabel, authMode } = req.rewind!;
    (req as Request & { auth?: unknown }).auth = { token: 'redacted', clientId: 'rewind-client', scopes: [], extra: { workspaceId, actorLabel, role: req.rewind!.auth?.workspace.role ?? 'member' } };
    // Onboarding milestone: an external client (API key) reached the server.
    const method = (req.body as { method?: string } | undefined)?.method;
    if (authMode === 'api_key' && (method === 'tools/list' || method === 'tools/call')) void app.accounts.milestone(workspaceId, 'first_mcp_call').catch(() => undefined);
    void mcpNode(req, res, req.body);
  });

  // ── JSON API ──
  const api = express.Router();
  api.use(limiter);

  api.get('/health', async (_req, res) => {
    let db = 'ok';
    try {
      await app.repo.ping();
    } catch (error) {
      db = error instanceof Error ? error.message : 'unavailable';
    }
    const adapters = await Promise.all(app.registry.list().map(async (a) => ({ id: a.id, ...(await a.health()) })));
    const healthy = db === 'ok' && adapters.every((a) => a.status === 'healthy');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', database: db, adapters, startedAt: app.startedAt, version: SERVER_INFO.version });
  });

  // ── Accounts ──
  const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(200);
  const password = z.string().min(10, 'Use at least 10 characters.').max(200);

  api.post('/auth/signup', authLimiter, async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1, 'Enter your name.').max(80), email, password, workspaceName: z.string().trim().max(80).optional() }).strict().parse(req.body);
    const s = await app.accounts.signup(body);
    setSessionCookie(req, res, s.token, s.expiresAt);
    void app.team.recordUserAgent(s.token, String(req.headers['user-agent'] ?? 'unknown')).catch(() => undefined);
    res.status(201).json({ ok: true });
  });

  /** Finish a first factor: either a session, or an MFA challenge held in a short-lived httpOnly cookie. */
  const finishLogin = (req: Request, res: Response, r: Awaited<ReturnType<typeof app.security.passwordLogin>>) => {
    if (r.kind === 'mfa') {
      res.cookie(MFA_COOKIE, r.challenge, { httpOnly: true, sameSite: 'lax', secure: cookieIsSecure(req), path: '/api/auth', maxAge: 5 * 60_000 });
      return { mfaRequired: true };
    }
    setSessionCookie(req, res, r.token, r.expiresAt);
    void app.team.recordUserAgent(r.token, String(req.headers['user-agent'] ?? 'unknown')).catch(() => undefined);
    return { ok: true };
  };

  api.post('/auth/login', authLimiter, async (req, res) => {
    const body = z.object({ email, password: z.string().min(1).max(200) }).strict().parse(req.body);
    res.json(finishLogin(req, res, await app.security.passwordLogin(body.email, body.password)));
  });

  api.post('/auth/mfa', authLimiter, async (req, res) => {
    const body = z.object({ code: z.string().trim().min(6).max(20) }).strict().parse(req.body);
    const challenge = readCookie(req, MFA_COOKIE);
    if (!challenge) throw new DomainError('UNAUTHORIZED', 'This sign-in attempt expired. Start again.');
    const s = await app.security.completeMfa(challenge, body.code);
    res.clearCookie(MFA_COOKIE, { path: '/api/auth' });
    setSessionCookie(req, res, s.token, s.expiresAt);
    void app.team.recordUserAgent(s.token, String(req.headers['user-agent'] ?? 'unknown')).catch(() => undefined);
    res.json({ ok: true });
  });

  // ── Single sign-on (OIDC) ──
  api.get('/auth/sso', (_req, res) => {
    res.json({ providers: app.sso.list() });
  });

  api.get('/auth/sso/:provider/start', authLimiter, async (req, res) => {
    const next = typeof req.query.next === 'string' ? req.query.next : null;
    res.redirect(302, await app.sso.start(String(req.params.provider), { next }));
  });

  api.get('/auth/sso/:provider/callback', async (req, res) => {
    const q = z.object({ code: z.string().max(4096).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(500).optional() }).parse(req.query);
    try {
      const r = await app.sso.callback(String(req.params.provider), q);
      if (r.linked) return res.redirect(302, '/app/settings/account?linked=' + encodeURIComponent(r.provider));
      const out = finishLogin(req, res, await app.security.afterFirstFactor(r.userId));
      if ('mfaRequired' in out) return res.redirect(302, `/login?mfa=1${r.next ? `&next=${encodeURIComponent(r.next)}` : ''}`);
      res.redirect(302, r.next ?? (r.isNew ? '/onboarding' : '/app'));
    } catch (error) {
      const message = error instanceof DomainError ? error.message : 'Single sign-on failed.';
      if (!(error instanceof DomainError)) app.log.error('sso.callback_failed', { message: error instanceof Error ? error.message : String(error) });
      res.redirect(302, `/login?sso_error=${encodeURIComponent(message)}`);
    }
  });

  api.post('/auth/guest', authLimiter, async (req, res) => {
    const s = await app.accounts.guest();
    setSessionCookie(req, res, s.token, s.expiresAt);
    void app.team.recordUserAgent(s.token, String(req.headers['user-agent'] ?? 'unknown')).catch(() => undefined);
    res.status(201).json({ ok: true });
  });

  api.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await app.accounts.logout(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.post('/auth/password/forgot', authLimiter, async (req, res) => {
    const body = z.object({ email }).strict().parse(req.body);
    await app.team.requestPasswordReset(body.email);
    res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
  });

  api.post('/auth/password/reset', authLimiter, async (req, res) => {
    const body = z.object({ token: z.string().regex(/^rwr_[A-Za-z0-9_-]{20,}$/, 'Invalid reset link.'), password }).strict().parse(req.body);
    const userId = await app.team.resetPassword(body.token, body.password);
    app.security.unlock(userId);
    res.json({ ok: true });
  });

  api.get('/invitations/preview/:token', authLimiter, async (req, res) => {
    const preview = await app.team.previewInvitation(String(req.params.token));
    if (!preview) throw new DomainError('NOT_FOUND', 'This invitation link is not valid.');
    res.json(preview);
  });

  const meBody = async (a: NonNullable<NonNullable<Request['rewind']>['auth']>) => ({
    user: { id: a.user.id, name: a.user.name, email: a.user.email, kind: a.user.kind, mfaEnabled: app.security.status(a.user.id).enabled },
    workspace: a.workspace,
    workspaces: await app.accounts.workspaces(a.user.id),
    milestones: await app.accounts.milestones(a.workspace.id),
    via: a.via,
  });

  // Browser session probe: 200 either way, so signed-out visitors see no console error.
  // It runs the same authentication as every other route and treats "not signed in" as an answer.
  api.get('/auth/session', (req, res, next) => {
    void auth(req, res, (err?: unknown) => {
      if (err) return err instanceof DomainError && err.code === 'UNAUTHORIZED' ? void res.json({ signedIn: false, me: null }) : next(err);
      const a = req.rewind?.auth;
      if (!a) return void res.json({ signedIn: false, me: null });
      meBody(a).then((me) => res.json({ signedIn: true, me }), next);
    });
  });

  api.use(auth);


  api.get('/auth/me', async (req, res) => {
    const a = req.rewind!.auth;
    if (!a) throw new DomainError('UNAUTHORIZED', 'Not signed in.');
    res.json(await meBody(a));
  });

  api.patch('/workspace', role('admin'), async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(req.body);
    await app.accounts.renameWorkspace(req.rewind!.workspaceId, body.name);
    res.json({ ok: true });
  });

  api.post('/onboarding/complete', role('member'), async (req, res) => {
    await app.accounts.completeOnboarding(req.rewind!.workspaceId);
    res.json({ ok: true });
  });

  api.get('/keys', async (req, res) => {
    res.json({ keys: await app.accounts.listApiKeys(req.rewind!.workspaceId) });
  });

  api.post('/keys', role('admin'), async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).strict().parse(req.body);
    const auth = req.rewind!.auth;
    if (!auth) throw new DomainError('FORBIDDEN', 'Sign in to the console to create keys.');
    const { key, record } = await app.accounts.createApiKey(auth, body.name);
    await app.repo.appendAudit({ workspaceId: auth.workspace.id, executionId: null, eventType: 'api_key.created', actor: callCtx(req, 'web_ui').actor, payload: { keyId: record.id, name: record.name, prefix: record.prefix } });
    res.status(201).json({ key, record });
  });

  api.delete('/keys/:id', role('admin'), async (req, res) => {
    const auth = req.rewind!.auth;
    if (!auth) throw new DomainError('FORBIDDEN', 'Sign in to the console to revoke keys.');
    await app.accounts.revokeApiKey(auth, String(req.params.id));
    await app.repo.appendAudit({ workspaceId: auth.workspace.id, executionId: null, eventType: 'api_key.revoked', actor: callCtx(req, 'web_ui').actor, payload: { keyId: String(req.params.id) } });
    res.json({ ok: true });
  });

  api.get('/activation', async (req, res) => {
    const a = req.rewind!.auth;
    const milestones = a ? await app.accounts.milestones(a.workspace.id) : {};
    const start = a ? Date.parse(a.workspace.createdAt) : null;
    const since = (m: string) => (start !== null && milestones[m] ? Date.parse(milestones[m]!) - start : null);
    res.json({
      milestones,
      timeToFirstExecutionMs: since('first_execution'),
      timeToFirstVerifiedRecoveryMs: since('first_verified_recovery'),
      timeToFirstMcpCallMs: since('first_mcp_call'),
    });
  });

  api.get('/overview', async (req, res) => {
    const ws = req.rewind!.workspaceId;
    const [stats, recent, recovery] = await Promise.all([
      app.repo.stats(ws),
      app.repo.listExecutions({ workspaceId: ws, limit: 8 }),
      app.repo.listRecentRecoveryAttempts(ws, 8),
    ]);
    res.json({ stats, recentExecutions: recent.items, recentRecoveryAttempts: recovery, environment: config.environment });
  });

  api.get('/executions', async (req, res) => {
    const q = z
      .object({
        status: z.union([z.enum(EXECUTION_STATUSES), z.array(z.enum(EXECUTION_STATUSES))]).optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().max(300).optional(),
      })
      .parse(req.query);
    const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
    const page = await app.repo.listExecutions({ workspaceId: req.rewind!.workspaceId, status, search: q.search || undefined, limit: q.limit, cursor: q.cursor });
    const summaries = await app.repo.actionSummaries(page.items.map((e) => e.id));
    const items = page.items.map((e) => {
      const sm = summaries.get(e.id);
      return {
        ...e,
        actionCount: sm?.count ?? 0,
        failurePoint: (e.failureActionId && sm?.failure.get(e.failureActionId)) || null,
        adapters: sm?.adapters ?? [],
      };
    });
    res.json({ items, nextCursor: page.nextCursor });
  });

  const stepBody = z.object({
    adapterId: z.string().max(40),
    operation: z.string().max(60),
    input: z.record(z.string(), z.unknown()).optional(),
    dependsOn: z.array(z.number().int()).max(20).optional(),
    dedupeKey: z.string().max(128).optional(),
  });

  api.post('/executions', role('member'), async (req, res) => {
    const body = z
      .object({ taskDescription: z.string().trim().min(3).max(500), idempotencyKey: z.string().max(128).optional(), plan: z.array(stepBody).max(20).optional(), run: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    const ctx = callCtx(req, 'http_api');
    const { execution, created } = await app.engine.createExecution(ctx, { ...body, source: 'http-api' });
    if (body.run && created) await app.engine.runPlan(ctx, execution.id);
    res.status(created ? 201 : 200).json(await app.queries.executionView(ctx.workspaceId, execution.id));
  });

  api.get('/executions/:id', async (req, res) => {
    res.json(await app.queries.executionView(req.rewind!.workspaceId, String(req.params.id)));
  });

  api.get('/aws', (_req, res) => {
    res.json(app.aws.status());
  });

  // Amazon Nova proposes steps; Rewind validates them. Nothing runs here: the agent executes the plan over MCP.
  api.post('/agent/plan', role('member'), async (req, res) => {
    const body = z.object({ request: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    res.json(await app.aws.plan(req.rewind!.workspaceId, body.request));
  });

  // Rewind's own spoken-style outcome, built from recorded state. Browsers read it aloud when Polly is off.
  api.get('/executions/:id/summary', async (req, res) => {
    const view = await app.queries.executionView(req.rewind!.workspaceId, String(req.params.id));
    res.json({ text: spokenSummary(view, (key) => app.registry.describe().find((o) => o.key === key)?.title ?? key) });
  });

  // Amazon Polly reads Rewind's deterministic summary of the execution.
  api.get('/executions/:id/voice.mp3', async (req, res) => {
    const view = await app.queries.executionView(req.rewind!.workspaceId, String(req.params.id));
    const audio = await app.aws.speak(req.rewind!.workspaceId, view);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('audio/mpeg').send(audio);
  });

  api.get('/executions/:id/report', async (req, res) => {
    const view = await app.queries.executionView(req.rewind!.workspaceId, String(req.params.id));
    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="rewind-${view.execution.id}.json"`);
      res.json({ kind: 'rewind.execution_report', sanitized: true, generatedAt: new Date().toISOString(), ...view });
      return;
    }
    res.type('text/markdown').send(renderReport(view));
  });

  api.get('/executions/:id/events', async (req, res) => {
    const ws = req.rewind!.workspaceId;
    const id = String(req.params.id);
    if (!(await app.repo.getExecution(ws, id))) throw new DomainError('NOT_FOUND', 'Execution not found.');
    sse(req, res, (e) => e.workspaceId === ws && e.executionId === id);
  });

  api.get('/events', (req, res) => {
    const ws = req.rewind!.workspaceId;
    sse(req, res, (e) => e.workspaceId === ws);
  });

  api.post('/executions/:id/run', role('member'), async (req, res) => {
    const ctx = callCtx(req, 'web_ui');
    await app.engine.runPlan(ctx, String(req.params.id));
    res.json(await app.queries.executionView(ctx.workspaceId, String(req.params.id)));
  });

  api.post('/executions/:id/recover', role('member'), async (req, res) => {
    const body = z.object({ requestKey: z.string().min(1).max(128), confirm: z.literal(true) }).strict().parse(req.body);
    const ctx = callCtx(req, 'web_ui');
    await app.engine.recover(ctx, String(req.params.id), { requestKey: body.requestKey });
    res.json(await app.queries.executionView(ctx.workspaceId, String(req.params.id)));
  });

  api.post('/executions/:id/actions/:actionId/approve', role('admin'), async (req, res) => {
    z.object({ confirm: z.literal(true) }).strict().parse(req.body);
    const ctx = callCtx(req, 'web_ui');
    await app.engine.approveAction(ctx, String(req.params.id), String(req.params.actionId));
    res.json(await app.queries.executionView(ctx.workspaceId, String(req.params.id)));
  });

  api.post('/executions/:id/actions/:actionId/reject', role('admin'), async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(3).max(200) }).strict().parse(req.body);
    const ctx = callCtx(req, 'web_ui');
    await app.engine.rejectAction(ctx, String(req.params.id), String(req.params.actionId), body.reason);
    res.json(await app.queries.executionView(ctx.workspaceId, String(req.params.id)));
  });

  api.post('/executions/:id/cancel', role('member'), async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(3).max(200) }).strict().parse(req.body);
    const ctx = callCtx(req, 'web_ui');
    await app.engine.cancelExecution(ctx, String(req.params.id), body.reason);
    res.json(await app.queries.executionView(ctx.workspaceId, String(req.params.id)));
  });

  api.get('/recovery', async (req, res) => {
    const ws = req.rewind!.workspaceId;
    const attention = await app.repo.listExecutions({ workspaceId: ws, status: ['partially_recovered', 'recovery_failed', 'failed', 'cancelled', 'recovering'], limit: 50 });
    const recovered = await app.repo.listExecutions({ workspaceId: ws, status: ['recovered'], limit: 20 });
    const views = await Promise.all([...attention.items, ...recovered.items].map((e) => app.queries.executionView(ws, e.id, { maxEvents: 0 })));
    res.json({
      items: views.map((v) => ({
        execution: v.execution,
        summary: v.summary,
        steps: v.actions.map((a) => ({
          id: a.id,
          sequence: a.sequence,
          operationKey: a.operationKey,
          operationTitle: a.operationTitle,
          status: a.status,
          capability: a.capability,
          recoveryOutcome: a.recoveryOutcome,
          recoveryOutcomeReason: a.recoveryOutcomeReason,
          attempts: a.recoveryAttempts,
        })),
        requests: v.recoveryRequests,
      })),
      attempts: await app.repo.listRecentRecoveryAttempts(ws, 50),
    });
  });

  api.get('/adapters', async (req, res) => {
    const policies = await app.repo.listPolicies(req.rewind!.workspaceId);
    const adapters = await Promise.all(
      app.registry.list().map(async (a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        version: a.version,
        description: a.description,
        disclosure: a.disclosure,
        connection: a.type === 'local-simulation' ? 'local' : 'configured',
        health: await a.health(),
        operations: app.registry
          .describe()
          .filter((o) => o.adapterId === a.id)
          .map((o) => ({ ...o, policy: evaluateActionPolicy(policies, o.key, o.kind) })),
      })),
    );
    res.json({ adapters });
  });

  api.get('/policies', async (req, res) => {
    res.json({ policies: await app.repo.listPolicies(req.rewind!.workspaceId) });
  });

  api.patch('/policies/:id', role('admin'), async (req, res) => {
    const body = z.object({ version: z.number().int(), enabled: z.boolean().optional(), configuration: z.record(z.string(), z.unknown()).optional() }).strict().parse(req.body);
    const ws = req.rewind!.workspaceId;
    const current = await app.repo.getPolicy(ws, String(req.params.id));
    if (!current) throw new DomainError('NOT_FOUND', 'Policy not found.');
    const configuration = body.configuration ? parsePolicyConfig(current.ruleType, body.configuration) : undefined;
    const updated = await app.repo.updatePolicy(ws, current.id, body.version, { enabled: body.enabled, configuration });
    await app.repo.appendAudit({
      workspaceId: ws,
      executionId: null,
      eventType: 'policy.updated',
      actor: callCtx(req, 'web_ui').actor,
      payload: { policyId: current.id, name: current.name, before: { enabled: current.enabled, configuration: current.configuration }, after: { enabled: updated.enabled, configuration: updated.configuration } },
    });
    res.json({ policy: updated });
  });

  api.get('/audit', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    res.json({ events: await app.repo.listWorkspaceAudit(req.rewind!.workspaceId, limit) });
  });

  // Demo controls: deterministic scenarios, fault injection, reset. Human-only; not exposed through MCP.
  api.get('/demo/scenarios', (_req, res) => {
    res.json({ scenarios: app.demo.scenarios() });
  });

  api.get('/demo/state', async (req, res) => {
    const ws = req.rewind!.workspaceId;
    res.json({ resources: app.demo.resources(ws), faults: app.demo.faults(ws), locks: await app.repo.listLocks(ws) });
  });

  api.post('/demo/scenarios/:id/run', role('member'), async (req, res) => {
    const body = z.object({ injectFaults: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const ctx = callCtx(req, 'web_ui');
    const exe = await app.demo.runScenario(ctx, String(req.params.id), body);
    res.status(201).json(await app.queries.executionView(ctx.workspaceId, exe.id));
  });

  api.post('/demo/faults', role('member'), (req, res) => {
    const body = z.object({ operation: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), mode: z.string().max(40), count: z.number().int().min(1).max(5).default(1) }).strict().parse(req.body);
    app.registry.resolve('home-sim', body.operation);
    res.status(201).json({ fault: app.demo.armFault(req.rewind!.workspaceId, body.operation, body.mode, body.count) });
  });

  api.delete('/demo/faults', role('member'), (req, res) => {
    app.demo.clearFaults(req.rewind!.workspaceId);
    res.json({ faults: [] });
  });

  api.post('/demo/reset', role('member'), async (req, res) => {
    const body = z.object({ confirm: z.literal('RESET'), clearHistory: z.boolean().default(false) }).strict().parse(req.body);
    if (body.clearHistory) requireRole(req.rewind!.auth!, 'admin');
    const ctx = callCtx(req, 'web_ui');
    res.json(await app.demo.reset(ctx.workspaceId, ctx.actor, { clearHistory: body.clearHistory }));
  });

  api.post('/retention/purge', role('admin'), async (req, res) => {
    z.object({ confirm: z.literal('PURGE') }).strict().parse(req.body);
    const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
    res.json(await app.repo.purgeOlderThan(req.rewind!.workspaceId, cutoff));
  });

  api.get('/settings', (req, res) => {
    res.json({
      workspace: { id: req.rewind!.workspaceId, name: req.rewind!.auth?.workspace.name ?? LOCAL_WORKSPACE.name, kind: req.rewind!.auth?.workspace.kind ?? 'standard' },
      environment: config.environment,
      mcp: {
        endpoint: `${config.publicUrl}${MCP_PATH}`,
        transport: 'streamable-http',
        protocolVersions: ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v >= '2025-03-26')],
        session: 'stateless',
        sdk: '@modelcontextprotocol/server 2.x',
      },
      auth: { console: 'session cookie (httpOnly, SameSite=Lax)', mcp: 'workspace API key (Bearer rwk_…) or console session', trustUpstream: config.trustUpstreamAuth, localOnly: config.localOnly },
      retentionDays: config.retentionDays,
      guestRetentionHours: config.guestRetentionHours,
      email: { provider: app.mailer.kind, from: app.mailer.kind === 'resend' ? config.mailFrom : null },
      sso: app.sso.list(),
      database: { engine: 'sqlite', path: config.dbPath },
      server: SERVER_INFO,
    });
  });

  // ── Team ──
  const auth_ = (req: Request) => {
    const a = req.rewind!.auth;
    if (!a || a.via !== 'session') throw new DomainError('FORBIDDEN', 'Use a signed-in console session for this action.');
    return a;
  };

  api.get('/members', async (req, res) => {
    res.json({ members: await app.team.members(req.rewind!.workspaceId) });
  });

  api.patch('/members/:userId', role('admin'), async (req, res) => {
    const body = z.object({ role: z.enum(ROLES) }).strict().parse(req.body);
    await app.team.setRole(auth_(req), String(req.params.userId), body.role);
    await app.repo.appendAudit({ workspaceId: req.rewind!.workspaceId, executionId: null, eventType: 'member.role_changed', actor: callCtx(req, 'web_ui').actor, payload: { userId: String(req.params.userId), role: body.role } });
    res.json({ ok: true });
  });

  api.delete('/members/:userId', async (req, res) => {
    await app.team.removeMember(auth_(req), String(req.params.userId));
    await app.repo.appendAudit({ workspaceId: req.rewind!.workspaceId, executionId: null, eventType: 'member.removed', actor: callCtx(req, 'web_ui').actor, payload: { userId: String(req.params.userId) } });
    res.json({ ok: true });
  });

  api.get('/invitations', role('admin'), async (req, res) => {
    res.json({ invitations: await app.team.invitations(req.rewind!.workspaceId) });
  });

  api.post('/invitations', role('admin'), async (req, res) => {
    const body = z.object({ role: z.enum(['admin', 'member', 'viewer']), email: email.optional() }).strict().parse(req.body);
    const { invitation, url } = await app.team.invite(auth_(req), body.role, body.email ?? null);
    await app.accounts.milestone(req.rewind!.workspaceId, 'first_invite');
    await app.repo.appendAudit({ workspaceId: req.rewind!.workspaceId, executionId: null, eventType: 'invitation.created', actor: callCtx(req, 'web_ui').actor, payload: { invitationId: invitation.id, role: body.role, email: body.email ?? null } });
    res.status(201).json({ invitation, url, emailed: Boolean(body.email), mailer: app.mailer.kind });
  });

  api.delete('/invitations/:id', role('admin'), async (req, res) => {
    await app.team.revokeInvitation(auth_(req), String(req.params.id));
    res.json({ ok: true });
  });

  api.post('/invitations/accept', async (req, res) => {
    const body = z.object({ token: z.string().regex(/^rwi_[A-Za-z0-9_-]{20,}$/, 'Invalid invitation link.') }).strict().parse(req.body);
    const r = await app.team.acceptInvitation(auth_(req), body.token, readCookie(req, SESSION_COOKIE));
    await app.repo.appendAudit({ workspaceId: r.workspaceId, executionId: null, eventType: 'member.joined', actor: callCtx(req, 'web_ui').actor, payload: { userId: req.rewind!.auth!.user.id, role: r.role } });
    res.json(r);
  });

  api.post('/session/workspace', async (req, res) => {
    const body = z.object({ workspaceId: z.string().regex(/^ws_[a-z0-9_]+$/) }).strict().parse(req.body);
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new DomainError('FORBIDDEN', 'Switching workspaces needs a console session.');
    res.json({ workspace: await app.team.switchWorkspace(auth_(req), token, body.workspaceId) });
  });

  api.delete('/workspace', role('owner'), async (req, res) => {
    const body = z.object({ confirmName: z.string().min(1).max(80) }).strict().parse(req.body);
    await app.team.deleteWorkspace(auth_(req), body.confirmName);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ── Account ──
  api.patch('/account', async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(req.body);
    await app.team.updateProfile(auth_(req), body.name);
    res.json({ ok: true });
  });

  api.post('/account/password', authLimiter, async (req, res) => {
    const body = z.object({ current: z.string().min(1).max(200), next: password }).strict().parse(req.body);
    const signedOut = await app.team.changePassword(auth_(req), body.current, body.next, readCookie(req, SESSION_COOKIE));
    res.json({ ok: true, otherSessionsSignedOut: signedOut });
  });

  api.post('/account/upgrade', authLimiter, async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), email, password }).strict().parse(req.body);
    await app.team.upgradeGuest(auth_(req), body);
    res.json({ ok: true });
  });

  api.get('/account/sessions', async (req, res) => {
    res.json({ sessions: await app.team.sessions(auth_(req), readCookie(req, SESSION_COOKIE)) });
  });

  api.post('/account/sessions/revoke-others', async (req, res) => {
    res.json({ signedOut: await app.team.revokeOtherSessions(auth_(req), readCookie(req, SESSION_COOKIE)) });
  });

  api.delete('/account/sessions/:id', async (req, res) => {
    await app.team.revokeSession(auth_(req), String(req.params.id));
    res.json({ ok: true });
  });

  // ── Account: two-factor authentication ──
  api.get('/account/mfa', (req, res) => {
    res.json(app.security.status(auth_(req).user.id));
  });

  api.post('/account/mfa/setup', authLimiter, async (req, res) => {
    const a = auth_(req);
    res.json(await app.security.beginEnrollment(a.user.id, a.user.email ?? a.user.name));
  });

  api.post('/account/mfa/enable', authLimiter, async (req, res) => {
    const body = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    res.json(await app.security.confirmEnrollment(auth_(req).user.id, body.code));
  });

  api.post('/account/mfa/disable', authLimiter, async (req, res) => {
    const body = z.object({ password: z.string().max(200).optional(), code: z.string().trim().min(6).max(20) }).strict().parse(req.body);
    await app.security.disable(auth_(req).user.id, body.password ?? null, body.code);
    res.json({ ok: true });
  });

  api.post('/account/mfa/recovery-codes', authLimiter, async (req, res) => {
    const body = z.object({ code: z.string().trim().min(6).max(20) }).strict().parse(req.body);
    res.json(await app.security.regenerateRecoveryCodes(auth_(req).user.id, body.code));
  });

  // ── Account: connected sign-in methods ──
  api.get('/account/identities', (req, res) => {
    res.json({ identities: app.sso.identities(auth_(req).user.id), available: app.sso.list() });
  });

  api.post('/account/identities/:provider', authLimiter, async (req, res) => {
    const a = auth_(req);
    res.json({ url: await app.sso.start(String(req.params.provider), { linkUserId: a.user.id }) });
  });

  api.delete('/account/identities/:provider', (req, res) => {
    app.sso.unlink(auth_(req).user.id, String(req.params.provider));
    res.json({ ok: true });
  });

  // ── Webhooks ──
  api.get('/webhooks', role('admin'), (req, res) => {
    const ws = req.rewind!.workspaceId;
    res.json({ webhooks: app.webhooks.list(ws).map((h) => ({ ...h, lastDelivery: app.webhooks.deliveries(ws, h.id, 1)[0] ?? null })), events: WEBHOOK_EVENTS });
  });

  api.post('/webhooks', role('admin'), async (req, res) => {
    const body = z.object({ url: z.string().max(500), description: z.string().max(120).optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }).strict().parse(req.body);
    const r = await app.webhooks.create(req.rewind!.workspaceId, req.rewind!.auth!.user.id, body);
    await app.repo.appendAudit({ workspaceId: req.rewind!.workspaceId, executionId: null, eventType: 'webhook.created', actor: callCtx(req, 'web_ui').actor, payload: { webhookId: r.webhook.id, url: r.webhook.url, events: r.webhook.events } });
    res.status(201).json(r);
  });

  api.patch('/webhooks/:id', role('admin'), (req, res) => {
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    app.webhooks.setEnabled(req.rewind!.workspaceId, String(req.params.id), body.enabled);
    res.json({ ok: true });
  });

  api.delete('/webhooks/:id', role('admin'), async (req, res) => {
    app.webhooks.remove(req.rewind!.workspaceId, String(req.params.id));
    await app.repo.appendAudit({ workspaceId: req.rewind!.workspaceId, executionId: null, eventType: 'webhook.deleted', actor: callCtx(req, 'web_ui').actor, payload: { webhookId: String(req.params.id) } });
    res.json({ ok: true });
  });

  api.get('/webhooks/:id/deliveries', role('admin'), (req, res) => {
    res.json({ deliveries: app.webhooks.deliveries(req.rewind!.workspaceId, String(req.params.id)) });
  });

  api.post('/webhooks/:id/test', role('admin'), async (req, res) => {
    res.json({ delivery: await app.webhooks.sendTest(req.rewind!.workspaceId, String(req.params.id)) });
  });

  // ── Usage ──
  api.get('/usage', async (req, res) => {
    const ws = req.rewind!.workspaceId;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [usage, members, keys] = await Promise.all([app.repo.usage(ws, monthStart), app.team.members(ws), app.accounts.listApiKeys(ws)]);
    res.json({ periodStart: monthStart, ...usage, members: members.length, activeApiKeys: keys.filter((k) => !k.revokedAt).length, webhooks: app.webhooks.list(ws).length });
  });

  api.use((_req, _res, next) => next(new DomainError('NOT_FOUND', 'No such API route.')));
  http.use('/api', api);

  // ── Web console ──
  const dist = resolve(process.cwd(), 'web', 'dist');
  if (existsSync(dist)) {
    http.use('/assets', express.static(join(dist, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
    http.use(express.static(dist, { index: false, maxAge: '1h' }));
    http.get(/^(?!\/api|\/mcp).*/, (req, res, next) => {
      // A missing file (anything with an extension) is a real 404, never the app shell.
      if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return next(new DomainError('NOT_FOUND', 'No such file.'));
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(dist, 'index.html'));
    });
  } else {
    http.get('/', (_req, res) => res.type('text/plain').send('Rewind API is running. Build the web console with `npm run build`, or run `npm run dev:web`.'));
  }

  http.use(errorHandler(app));
  return http;

  function sse(req: Request, res: Response, filter: (e: { workspaceId: string; executionId: string; eventType: string; seq: number }) => boolean) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const onEvent = (e: { workspaceId: string; executionId: string; eventType: string; seq: number }) => {
      if (filter(e)) res.write(`event: update\ndata: ${JSON.stringify({ executionId: e.executionId, eventType: e.eventType, seq: e.seq })}\n\n`);
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    app.engine.events.on('event', onEvent);
    req.on('close', () => {
      clearInterval(ping);
      app.engine.events.off('event', onEvent);
    });
  }
}

function callCtx(req: Request, type: Actor['type']): CallContext {
  return { workspaceId: req.rewind!.workspaceId, actor: { type, label: req.rewind!.actorLabel } };
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const MFA_COOKIE = 'rewind_mfa';

/** Secure when served over HTTPS, or always when REWIND_COOKIE_SECURE=true. */
function cookieIsSecure(req: Request) {
  const cfg = (req.app.locals.cookieSecure as string | undefined) ?? 'auto';
  return cfg === 'true' || (cfg === 'auto' && req.secure);
}

function setSessionCookie(req: Request, res: Response, token: string, expires: Date) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: cookieIsSecure(req), path: '/', expires });
}

/**
 * Every API and MCP request is authenticated:
 *  - `Authorization: Bearer rwk_…` (workspace API key) for programmatic clients;
 *  - the `rewind_session` cookie for the console, including the in-browser agent simulation;
 *  - on /mcp only, when REWIND_TRUST_UPSTREAM_AUTH=agentcore, a request the platform already
 *    authenticated is mapped to the built-in workspace.
 * The workspace always comes from the credential, never from the client.
 */
function authenticate(app: App, opts: { allowUpstream: boolean }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? '';
      if (header.startsWith('Bearer ')) {
        const a = await app.accounts.fromApiKey(header.slice(7).trim());
        if (!a) return next(new DomainError('UNAUTHORIZED', 'Invalid or revoked API key.'));
        req.rewind = { workspaceId: a.workspace.id, authMode: 'api_key', actorLabel: `api-key ${a.apiKeyId}`, auth: a };
        return next();
      }
      const token = readCookie(req, SESSION_COOKIE);
      const a = token ? await app.accounts.fromSession(token) : null;
      if (a) {
        req.rewind = { workspaceId: a.workspace.id, authMode: 'session', actorLabel: a.user.kind === 'guest' ? 'guest' : a.user.name, auth: a };
        return next();
      }
      if (opts.allowUpstream) {
        req.rewind = { workspaceId: LOCAL_WORKSPACE.id, authMode: 'upstream', actorLabel: 'agentcore-caller' };
        return next();
      }
      next(new DomainError('UNAUTHORIZED', 'Sign in, or send a workspace API key as a Bearer token.'));
    } catch (error) {
      next(error);
    }
  };
}

/** Fixed-window, per-client-address limiter. Single-process only; not shared across instances. */
function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { count: 1, reset: now + opts.windowMs });
    else if (++h.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return next(new DomainError('LIMIT_EXCEEDED', 'Too many requests. Slow down and retry shortly.'));
    }
    if (hits.size > 10_000) for (const [key, v] of hits) if (v.reset < now) hits.delete(key);
    next();
  };
}

function errorHandler(app: App) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: z.prettifyError(error), issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
      return;
    }
    if (error instanceof DomainError) {
      res.status(httpStatusFor(error.code)).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error && typeof error === 'object' && 'type' in error && (error as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_FAILED', message: 'Request body too large.' } });
      return;
    }
    app.log.error('http.unhandled_error', { path: req.path, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'An internal error occurred. It has been logged.' } });
  };
}
