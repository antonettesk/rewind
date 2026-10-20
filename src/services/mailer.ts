import type { Logger } from '../logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Outbound email port. */
export interface Mailer {
  readonly kind: string;
  send(mail: Mail): Promise<void>;
}

/**
 * Development mailer: no email leaves the machine. Messages (including reset
 * links) are written to the server log so a local operator can complete the
 * flow. Used when REWIND_RESEND_API_KEY is not set.
 */
export class LogMailer implements Mailer {
  readonly kind = 'log';
  constructor(private readonly log: Logger) {}
  async send(mail: Mail) {
    this.log.warn('mail.outbox', { to: mail.to, subject: mail.subject, body: mail.text, note: 'Email delivery is not configured (set REWIND_RESEND_API_KEY); message written to the log only.' });
  }
}

/**
 * Resend (https://resend.com) over its REST API. One retry on 429/5xx.
 * Without a verified sending domain, Resend only accepts mail from
 * onboarding@resend.dev to the account owner's own address.
 */
export class ResendMailer implements Mailer {
  readonly kind = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpoint = 'https://api.resend.com/emails',
  ) {}

  async send(mail: Mail) {
    const body = JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'REWIND/1.0' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const { id } = (await res.json().catch(() => ({}))) as { id?: string };
        this.log.info('mail.sent', { provider: 'resend', id, subject: mail.subject });
        return;
      }
      const detail = await res.text().catch(() => '');
      if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 750));
        continue;
      }
      this.log.error('mail.failed', { provider: 'resend', status: res.status, detail: detail.slice(0, 300), subject: mail.subject });
      throw new Error(`Email delivery failed (Resend HTTP ${res.status}).`);
    }
  }
}

/** Test mailer: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly kind = 'memory';
  readonly outbox: Mail[] = [];
  async send(mail: Mail) {
    this.outbox.push(mail);
  }
}
