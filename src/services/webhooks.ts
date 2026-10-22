/**
 * Outbound webhooks: notify other systems when an execution needs attention,
 * recovers, succeeds, or waits for approval.
 *
 * - Every delivery is signed: `Rewind-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * - Targets must be HTTPS. Private, loopback and link-local addresses are refused
 *   (checked after DNS resolution, to block SSRF), unless explicitly allowed for local development.
 * - Up to 3 attempts with backoff; every attempt is recorded. Redirects are not followed.
 * - Delivery happens off the request path, in-process. It is at-least-once while the
 *   process runs; deliveries pending at shutdown are not resumed (documented limitation).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainError } from '../domain/errors.js';
import type { EngineEvent } from '../engine/engine.js';
import type { Logger } from '../logger.js';
import type { Db } from '../persistence/db.js';
import { newId, nowIso } from '../domain/util.js';

export const WEBHOOK_EVENTS = ['execution.needs_attention', 'execution.recovered', 'execution.succeeded', 'execution.failed', 'approval.requested'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  workspaceId: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
}

export interface Delivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  executionId: string | null;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

type Row = Record<string, any>;
const toHook = (r: Row): Webhook => ({
  id: r.id,
  workspaceId: r.workspace_id,
  url: r.url,
  description: r.description,
  events: JSON.parse(r.events_json),
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});
const toDelivery = (r: Row): Delivery => ({
  id: r.id,
  webhookId: r.webhook_id,
  eventId: r.event_id,
  eventType: r.event_type,
  executionId: r.execution_id ?? null,
  attempt: r.attempt,
  status: r.status,
  responseCode: r.response_code ?? null,
  error: r.error ?? null,
  durationMs: r.duration_ms ?? null,
  createdAt: r.created_at,
});

export function sign(secret: string, timestamp: number, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

export class WebhookService {
  private backoffMs = [0, 2_000, 10_000];

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly opts: { allowPrivate: boolean; publicUrl: string },
  ) {}

  /** Tests shorten the retry schedule. */
  setBackoff(ms: number[]) {
    this.backoffMs = ms;
  }

  async validateUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'Enter a valid URL.');
    }
    if (url.username || url.password) throw new DomainError('VALIDATION_FAILED', 'URLs with embedded credentials are not allowed.');
    if (url.protocol !== 'https:' && !(this.opts.allowPrivate && url.protocol === 'http:')) {
      throw new DomainError('VALIDATION_FAILED', 'Webhook URLs must use HTTPS.');
    }
    if (!this.opts.allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
      if (!addrs.length) throw new DomainError('VALIDATION_FAILED', `Could not resolve ${host}.`);
      if (addrs.some(isPrivateAddress)) throw new DomainError('VALIDATION_FAILED', 'Webhook URLs may not point to private, loopback or link-local addresses.');
    }
    return url;
  }

  async create(workspaceId: string, createdBy: string, input: { url: string; description?: string; events: WebhookEvent[] }) {
    const url = await this.validateUrl(input.url);
    if ((this.list(workspaceId)).length >= 10) throw new DomainError('LIMIT_EXCEEDED', 'A workspace can have at most 10 webhooks.');
    const id = newId('evt').replace('evt_', 'whk_');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    this.db
      .prepare('INSERT INTO webhooks (id, workspace_id, url, description, events_json, secret, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, workspaceId, url.toString(), input.description ?? '', JSON.stringify(input.events), secret, createdBy, nowIso());
    return { webhook: this.get(workspaceId, id)!, secret };
  }

  list(workspaceId: string): Webhook[] {
    return (this.db.prepare('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Row[]).map(toHook);
  }

  get(workspaceId: string, id: string): Webhook | null {
    const r = this.db.prepare('SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Row | undefined;
    return r ? toHook(r) : null;
  }

  setEnabled(workspaceId: string, id: string, enabled: boolean) {
    if (this.db.prepare('UPDATE webhooks SET enabled = ? WHERE id = ? AND workspace_id = ?').run(enabled ? 1 : 0, id, workspaceId).changes !== 1) {
      throw new DomainError('NOT_FOUND', 'Webhook not found.');
    }
  }

  remove(workspaceId: string, id: string) {
    if (!this.get(workspaceId, id)) throw new DomainError('NOT_FOUND', 'Webhook not found.');
    this.db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  deliveries(workspaceId: string, webhookId: string, limit = 50): Delivery[] {
    return (this.db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(webhookId, workspaceId, limit) as Row[]).map(toDelivery);
  }

  /** Map engine events to webhook events and queue deliveries. Never throws into the engine. */
  onEngineEvent(e: EngineEvent, lookupExecution: (ws: string, id: string) => Promise<{ status: string; taskDescription: string } | null>) {
    let type: WebhookEvent | null = null;
    if (e.eventType === 'approval.requested') type = 'approval.requested';
    if (e.eventType === 'execution.status_changed') {
      const to = e.payload.to as string;
      type = to === 'succeeded' ? 'execution.succeeded' : to === 'recovered' ? 'execution.recovered' : to === 'partially_recovered' || to === 'recovery_failed' ? 'execution.needs_attention' : null;
    }
    if (e.eventType === 'recovery.not_required' || e.eventType === 'recovery.awaiting_request') type = 'execution.failed';
    if (!type) return;
    const hooks = this.list(e.workspaceId).filter((h) => h.enabled && h.events.includes(type!));
    if (!hooks.length) return;
    void lookupExecution(e.workspaceId, e.executionId)
      .then((exe) => {
        const data = { executionId: e.executionId, status: exe?.status ?? null, taskDescription: exe?.taskDescription ?? null, url: `${this.opts.publicUrl}/app/executions/${e.executionId}` };
        for (const h of hooks) void this.deliver(h, type!, data, e.executionId);
      })
      .catch((err: unknown) => this.log.error('webhook.dispatch_failed', { message: err instanceof Error ? err.message : String(err) }));
  }

  async sendTest(workspaceId: string, id: string) {
    const h = this.get(workspaceId, id);
    if (!h) throw new DomainError('NOT_FOUND', 'Webhook not found.');
    return this.deliver(h, 'webhook.test', { message: 'Test event from Rewind. If you can read this, signatures verify and delivery works.' }, null, 1);
  }

  /** Deliver one event, retrying on network errors and 5xx/429. Resolves with the final delivery record. */
  async deliver(h: Webhook, type: string, data: Record<string, unknown>, executionId: string | null, maxAttempts = this.backoffMs.length): Promise<Delivery> {
    const eventId = newId('evt');
    const body = JSON.stringify({ id: eventId, type, createdAt: nowIso(), workspaceId: h.workspaceId, data });
    const secret = (this.db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(h.id) as Row | undefined)?.secret as string | undefined;
    let last: Delivery | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const wait = this.backoffMs[attempt - 1] ?? 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const id = newId('evt').replace('evt_', 'dlv_');
      const started = Date.now();
      let status: Delivery['status'] = 'failed';
      let code: number | null = null;
      let error: string | null = null;
      try {
        if (!secret) throw new Error('Webhook was deleted.');
        await this.validateUrl(h.url); // re-check at send time: DNS can change
        const t = Math.floor(Date.now() / 1000);
        const res = await fetch(h.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Rewind-Webhooks/1.0',
            'Rewind-Event': type,
            'Rewind-Delivery': eventId,
            'Rewind-Signature': `t=${t},v1=${sign(secret, t, body)}`,
          },
          body,
        });
        code = res.status;
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 300) status = 'delivered';
        else error = `HTTP ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message.slice(0, 300) : String(err);
      }
      this.db
        .prepare('INSERT INTO webhook_deliveries (id, webhook_id, workspace_id, event_id, event_type, execution_id, attempt, status, response_code, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, h.id, h.workspaceId, eventId, type, executionId, attempt, status, code, error, Date.now() - started, nowIso());
      last = toDelivery(this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as Row);
      const retryable = status === 'failed' && (code === null || code === 429 || code >= 500);
      if (status === 'delivered' || !retryable) break;
    }
    if (last?.status === 'failed') this.log.warn('webhook.delivery_failed', { webhookId: h.id, type, error: last.error, code: last.responseCode });
    return last!;
  }
}
