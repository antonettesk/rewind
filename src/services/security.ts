/**
 * Sign-in security: account lockout, TOTP multi-factor authentication and
 * one-time recovery codes.
 *
 * Lockout: 5 consecutive failed password or MFA attempts lock the account for
 * 15 minutes (doubling for each further lock, up to 24 hours). The owner is
 * emailed. A successful sign-in resets the counter.
 *
 * MFA: RFC 6238 TOTP (any authenticator app). Seeds are encrypted at rest; the
 * last accepted time step is stored so a code cannot be replayed. Ten single-use
 * recovery codes are issued at enrollment and stored as SHA-256 hashes.
 */
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { DomainError } from '../domain/errors.js';
import { nowIso, sha256 } from '../domain/util.js';
import type { Db } from '../persistence/db.js';
import { transaction } from '../persistence/db.js';
import { hashPassword, verifyPassword, type AccountService } from './accounts.js';
import { newTotpSecret, verifyTotp, type SecretBox } from './crypto.js';
import type { Mailer } from './mailer.js';
import { emailTemplate } from './email-templates.js';

export const MAX_FAILED = 5;
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 3600_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;

type Row = Record<string, any>;

/** Ten 10-character hex codes (40 bits each). Shown once, stored hashed. */
const newRecoveryCodes = () => Array.from({ length: 10 }, () => randomBytes(5).toString('hex'));

export type LoginResult = { kind: 'session'; token: string; expiresAt: Date } | { kind: 'mfa'; challenge: string };

export class SecurityService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountService,
    private readonly box: SecretBox,
    private readonly mailer: Mailer,
    private readonly publicUrl: string,
  ) {}

  private user(email: string): Row | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as Row | undefined;
  }

  private assertNotLocked(u: Row) {
    if (u.locked_until && u.locked_until > nowIso()) {
      const minutes = Math.ceil((Date.parse(u.locked_until) - Date.now()) / 60_000);
      throw new DomainError('ACCOUNT_LOCKED', `Too many failed attempts. This account is locked for ${minutes} more minute${minutes === 1 ? '' : 's'}. Reset your password to unlock it sooner.`, { lockedUntil: u.locked_until });
    }
  }

  /** Record a failed attempt; lock and notify when the threshold is reached. */
  private async fail(u: Row) {
    const failures = Number(u.failed_logins ?? 0) + 1;
    if (failures >= MAX_FAILED) {
      const previousLocks = Math.max(0, Math.floor(failures / MAX_FAILED) - 1);
      const ms = Math.min(BASE_LOCK_MS * 2 ** previousLocks, MAX_LOCK_MS);
      const until = new Date(Date.now() + ms).toISOString();
      this.db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures, until, u.id);
      if (u.email) {
        await this.mailer
          .send(
            emailTemplate({
              to: u.email,
              subject: 'Your REWIND account was locked',
              heading: 'We locked your account to protect it',
              body: [`There were ${failures} failed sign-in attempts in a row. Sign-in is paused until ${new Date(until).toUTCString()}.`, 'If this was you, wait or reset your password. If it was not, reset your password now.'],
              action: { label: 'Reset password', url: `${this.publicUrl}/forgot-password` },
            }),
          )
          .catch(() => undefined);
      }
    } else {
      this.db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failures, u.id);
    }
  }

  private reset(userId: string) {
    this.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(userId);
  }

  /** Clear a lock, e.g. after a successful password reset. */
  unlock(userId: string) {
    this.reset(userId);
  }

  async passwordLogin(email: string, password: string): Promise<LoginResult> {
    const u = this.user(email);
    this.dummyHash ??= hashPassword(randomBytes(12).toString('hex'));
    if (u) this.assertNotLocked(u);
    const ok = await verifyPassword(password, u?.password_hash ?? (await this.dummyHash));
    if (!u || !u.password_hash || u.kind !== 'member' || !ok) {
      if (u && u.kind === 'member') await this.fail(u);
      throw new DomainError('UNAUTHORIZED', 'Email or password is incorrect.');
    }
    return this.afterFirstFactor(u.id);
  }

  /** Password or SSO succeeded: either finish, or require the second factor. */
  async afterFirstFactor(userId: string): Promise<LoginResult> {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row;
    this.assertNotLocked(u);
    if (u.mfa_enabled_at) {
      const challenge = `rwm_${randomBytes(24).toString('base64url')}`;
      this.db
        .prepare('INSERT INTO mfa_challenges (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256(challenge), userId, nowIso(), new Date(Date.now() + CHALLENGE_TTL_MS).toISOString());
      return { kind: 'mfa', challenge };
    }
    this.reset(userId);
    const s = await this.accounts.sessionForUser(userId);
    return { kind: 'session', ...s };
  }

  /** Second step: a 6-digit TOTP code or a recovery code. */
  async completeMfa(challenge: string, code: string) {
    const c = this.db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?').get(sha256(challenge)) as Row | undefined;
    if (!c || c.expires_at <= nowIso() || c.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      throw new DomainError('UNAUTHORIZED', 'This sign-in attempt expired. Start again.');
    }
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id) as Row;
    this.assertNotLocked(u);
    const ok = this.checkSecondFactor(u, code.trim());
    if (!ok) {
      this.db.prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(c.token_hash);
      await this.fail(u);
      throw new DomainError('UNAUTHORIZED', 'That code is not valid. Check your authenticator app, or use a recovery code.');
    }
    this.db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(c.token_hash);
    this.reset(u.id);
    return this.accounts.sessionForUser(u.id);
  }

  private checkSecondFactor(u: Row, code: string): boolean {
    if (!u.mfa_secret_enc) return false;
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(this.box.open(u.mfa_secret_enc), code);
      // Reject replay of a code that was already used.
      if (step === null || (u.mfa_last_step !== null && step <= u.mfa_last_step)) return false;
      this.db.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').run(step, u.id);
      return true;
    }
    const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.length !== 10) return false;
    const res = this.db.prepare('UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(nowIso(), u.id, sha256(normalized));
    return res.changes === 1;
  }

  // ── Enrollment ──
  status(userId: string) {
    const u = this.db.prepare('SELECT mfa_enabled_at FROM users WHERE id = ?').get(userId) as Row;
    const remaining = (this.db.prepare('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as Row).n;
    return { enabled: Boolean(u?.mfa_enabled_at), enabledAt: u?.mfa_enabled_at ?? null, recoveryCodesRemaining: u?.mfa_enabled_at ? remaining : 0 };
  }

  async beginEnrollment(userId: string, accountLabel: string) {
    const secret = newTotpSecret();
    this.db.prepare('UPDATE users SET mfa_pending_enc = ? WHERE id = ?').run(this.box.seal(secret), userId);
    const uri = `otpauth://totp/${encodeURIComponent(`REWIND:${accountLabel}`)}?secret=${secret}&issuer=REWIND&algorithm=SHA1&digits=6&period=30`;
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  async confirmEnrollment(userId: string, code: string) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row;
    if (!u.mfa_pending_enc) throw new DomainError('INVALID_TRANSITION', 'Start MFA setup first.');
    const secret = this.box.open(u.mfa_pending_enc);
    const step = verifyTotp(secret, code.trim());
    if (step === null) throw new DomainError('VALIDATION_FAILED', 'That code does not match. Check the time on your device and try the newest code.');
    const codes = newRecoveryCodes();
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET mfa_secret_enc = ?, mfa_pending_enc = NULL, mfa_enabled_at = ?, mfa_last_step = ? WHERE id = ?').run(u.mfa_pending_enc, nowIso(), step, userId);
      this.db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
      for (const c of codes) this.db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(userId, sha256(c));
    });
    if (u.email) {
      await this.mailer
        .send(emailTemplate({ to: u.email, subject: 'Two-factor authentication is on', heading: 'Two-factor authentication enabled', body: ['Your REWIND account now asks for a code from your authenticator app at sign-in.', "If you didn't do this, reset your password immediately."] }))
        .catch(() => undefined);
    }
    return { recoveryCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
  }

  async disable(userId: string, password: string | null, code: string) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row;
    if (!u.mfa_enabled_at) throw new DomainError('INVALID_TRANSITION', 'Two-factor authentication is not enabled.');
    if (u.password_hash && !(password && (await verifyPassword(password, u.password_hash)))) throw new DomainError('UNAUTHORIZED', 'Your password is incorrect.');
    if (!this.checkSecondFactor(u, code.trim())) throw new DomainError('UNAUTHORIZED', 'That code is not valid.');
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET mfa_secret_enc = NULL, mfa_pending_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = ?').run(userId);
      this.db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    });
    if (u.email) {
      await this.mailer
        .send(emailTemplate({ to: u.email, subject: 'Two-factor authentication was turned off', heading: 'Two-factor authentication disabled', body: ["Sign-in to your REWIND account no longer asks for an authenticator code.", "If you didn't do this, reset your password and turn it back on."] }))
        .catch(() => undefined);
    }
  }

  async regenerateRecoveryCodes(userId: string, code: string) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row;
    if (!u.mfa_enabled_at || !this.checkSecondFactor(u, code.trim())) throw new DomainError('UNAUTHORIZED', 'That code is not valid.');
    const codes = newRecoveryCodes();
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
      for (const c of codes) this.db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(userId, sha256(c));
    });
    return { recoveryCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
  }

  cleanup() {
    const t = nowIso();
    this.db.prepare('DELETE FROM mfa_challenges WHERE expires_at <= ?').run(t);
    this.db.prepare('DELETE FROM sso_states WHERE expires_at <= ?').run(t);
  }
}
