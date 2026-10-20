/**
 * Identity persistence: users, workspace memberships, sessions, API keys and
 * activation milestones. Same pattern as Repository: an async port with a
 * SQLite implementation. Secrets are never stored, only their SHA-256.
 */
import { DomainError } from '../domain/errors.js';
import { nowIso } from '../domain/util.js';
import { transaction, type Db } from './db.js';

export interface User {
  id: string;
  email: string | null;
  name: string;
  kind: 'member' | 'guest';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: 'standard' | 'guest';
  role: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: string;
  onboardingCompletedAt: string | null;
}

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface SessionRecord {
  userId: string;
  workspaceId: string;
  expiresAt: string;
}

export interface AccountStore {
  createUserWithWorkspace(u: { userId: string; email: string | null; name: string; passwordHash: string | null; kind: User['kind'] }, w: { id: string; name: string; kind: WorkspaceSummary['kind'] }): Promise<void>;
  findUserByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null>;
  getUser(id: string): Promise<User | null>;
  touchLogin(userId: string): Promise<void>;
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  completeOnboarding(workspaceId: string): Promise<void>;
  createSession(s: { tokenHash: string; userId: string; workspaceId: string; expiresAt: string }): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  touchSession(tokenHash: string): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(): Promise<number>;
  createApiKey(k: { id: string; workspaceId: string; name: string; prefix: string; keyHash: string; createdBy: string }): Promise<ApiKeyRecord>;
  findApiKey(keyHash: string): Promise<ApiKeyRecord | null>;
  touchApiKey(id: string): Promise<void>;
  listApiKeys(workspaceId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(workspaceId: string, id: string): Promise<boolean>;
  recordMilestone(workspaceId: string, milestone: string): Promise<boolean>;
  listMilestones(workspaceId: string): Promise<Record<string, string>>;
  listGuestWorkspacesOlderThan(cutoffIso: string): Promise<string[]>;
  deleteWorkspaceIdentity(workspaceId: string): Promise<void>;
}

type Row = Record<string, any>;
const toUser = (r: Row): User => ({ id: r.id, email: r.email ?? null, name: r.name, kind: r.kind, createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null });
const toKey = (r: Row): ApiKeyRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  prefix: r.prefix,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? null,
  revokedAt: r.revoked_at ?? null,
});

export class SqliteAccountStore implements AccountStore {
  constructor(private readonly db: Db) {}

  async createUserWithWorkspace(u: Parameters<AccountStore['createUserWithWorkspace']>[0], w: Parameters<AccountStore['createUserWithWorkspace']>[1]) {
    const t = nowIso();
    try {
      transaction(this.db, () => {
        this.db.prepare('INSERT INTO users (id, email, name, password_hash, kind, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(u.userId, u.email, u.name, u.passwordHash, u.kind, t, t);
        this.db.prepare('INSERT INTO workspaces (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(w.id, w.name, w.kind, t, t);
        this.db.prepare("INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(u.userId, w.id, t);
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: users.email/.test(error.message)) {
        throw new DomainError('VALIDATION_FAILED', 'An account with this email already exists. Sign in instead.', { field: 'email' });
      }
      throw error;
    }
  }

  async findUserByEmail(email: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Row | undefined;
    return r ? { ...toUser(r), passwordHash: r.password_hash ?? null } : null;
  }

  async getUser(id: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? toUser(r) : null;
  }

  async touchLogin(userId: string) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), userId);
  }

  async listWorkspaces(userId: string) {
    return (
      this.db
        .prepare('SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at')
        .all(userId) as Row[]
    ).map((r) => ({ id: r.id, name: r.name, kind: r.kind, role: r.role, createdAt: r.created_at, onboardingCompletedAt: r.onboarding_completed_at ?? null }));
  }

  async renameWorkspace(workspaceId: string, name: string) {
    this.db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), workspaceId);
  }

  async completeOnboarding(workspaceId: string) {
    this.db.prepare('UPDATE workspaces SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?) WHERE id = ?').run(nowIso(), workspaceId);
  }

  async createSession(s: Parameters<AccountStore['createSession']>[0]) {
    const t = nowIso();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, workspace_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(s.tokenHash, s.userId, s.workspaceId, t, s.expiresAt, t);
  }

  async findSession(tokenHash: string) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, nowIso()) as Row | undefined;
    return r ? { userId: r.user_id, workspaceId: r.workspace_id, expiresAt: r.expires_at } : null;
  }

  async touchSession(tokenHash: string) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
  }

  async deleteSession(tokenHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async deleteExpiredSessions() {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes);
  }

  async createApiKey(k: Parameters<AccountStore['createApiKey']>[0]) {
    this.db
      .prepare('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(k.id, k.workspaceId, k.name, k.prefix, k.keyHash, k.createdBy, nowIso());
    return toKey(this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(k.id) as Row);
  }

  async findApiKey(keyHash: string) {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(keyHash) as Row | undefined;
    return r ? toKey(r) : null;
  }

  async touchApiKey(id: string) {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  async listApiKeys(workspaceId: string) {
    return (this.db.prepare('SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as Row[]).map(toKey);
  }

  async revokeApiKey(workspaceId: string, id: string) {
    return this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').run(nowIso(), id, workspaceId).changes === 1;
  }

  async recordMilestone(workspaceId: string, milestone: string) {
    return this.db.prepare('INSERT OR IGNORE INTO workspace_milestones (workspace_id, milestone, reached_at) VALUES (?, ?, ?)').run(workspaceId, milestone, nowIso()).changes === 1;
  }

  async listMilestones(workspaceId: string) {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT milestone, reached_at FROM workspace_milestones WHERE workspace_id = ?').all(workspaceId) as Row[]) out[r.milestone] = r.reached_at;
    return out;
  }

  async listGuestWorkspacesOlderThan(cutoffIso: string) {
    return (this.db.prepare("SELECT id FROM workspaces WHERE kind = 'guest' AND created_at < ?").all(cutoffIso) as Row[]).map((r) => r.id as string);
  }

  async deleteWorkspaceIdentity(workspaceId: string) {
    transaction(this.db, () => {
      const users = (this.db.prepare('SELECT user_id FROM memberships WHERE workspace_id = ?').all(workspaceId) as Row[]).map((r) => r.user_id as string);
      for (const t of ['sessions', 'api_keys', 'workspace_milestones', 'webhook_deliveries', 'webhooks', 'invitations', 'memberships', 'sim_resources', 'sim_faults', 'policies']) {
        this.db.prepare(`DELETE FROM ${t} WHERE workspace_id = ?`).run(workspaceId);
      }
      for (const u of users) {
        const other = this.db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(u);
        if (!other) {
          this.db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u);
          this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u);
          this.db.prepare('DELETE FROM users WHERE id = ?').run(u);
        }
      }
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    });
  }
}
