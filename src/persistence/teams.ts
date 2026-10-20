/**
 * Team and account-security persistence: members and roles, invitation links,
 * password resets and session management. Secrets are stored only as SHA-256.
 */
import { DomainError } from '../domain/errors.js';
import { nowIso } from '../domain/util.js';
import { transaction, type Db } from './db.js';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export interface Member {
  userId: string;
  name: string;
  email: string | null;
  role: Role;
  joinedAt: string;
  lastLoginAt: string | null;
}

export interface Invitation {
  id: string;
  workspaceId: string;
  role: Exclude<Role, 'owner'>;
  email: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface SessionInfo {
  id: string; // first 12 hex chars of the token hash: an opaque handle, never the token
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  workspaceId: string;
}

type Row = Record<string, any>;
const toInvite = (r: Row): Invitation => ({
  id: r.id,
  workspaceId: r.workspace_id,
  role: r.role,
  email: r.email ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  acceptedAt: r.accepted_at ?? null,
  revokedAt: r.revoked_at ?? null,
});

export class SqliteTeamStore {
  constructor(private readonly db: Db) {}

  async listMembers(workspaceId: string): Promise<Member[]> {
    return (
      this.db
        .prepare('SELECT u.id, u.name, u.email, u.last_login_at, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at')
        .all(workspaceId) as Row[]
    ).map((r) => ({ userId: r.id, name: r.name, email: r.email ?? null, role: r.role, joinedAt: r.created_at, lastLoginAt: r.last_login_at ?? null }));
  }

  async roleOf(userId: string, workspaceId: string): Promise<Role | null> {
    const r = this.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?').get(userId, workspaceId) as Row | undefined;
    return (r?.role as Role) ?? null;
  }

  /** Change a member's role. Refuses to leave a workspace without an owner. */
  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    transaction(this.db, () => {
      const current = this.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?').get(userId, workspaceId) as Row | undefined;
      if (!current) throw new DomainError('NOT_FOUND', 'That person is not a member of this workspace.');
      if (current.role === 'owner' && role !== 'owner' && this.ownerCount(workspaceId) <= 1) {
        throw new DomainError('INVALID_TRANSITION', 'A workspace must keep at least one owner. Make someone else an owner first.');
      }
      this.db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = ?').run(role, userId, workspaceId);
    });
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    transaction(this.db, () => {
      const current = this.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?').get(userId, workspaceId) as Row | undefined;
      if (!current) throw new DomainError('NOT_FOUND', 'That person is not a member of this workspace.');
      if (current.role === 'owner' && this.ownerCount(workspaceId) <= 1) throw new DomainError('INVALID_TRANSITION', 'The last owner cannot be removed.');
      this.db.prepare('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?').run(userId, workspaceId);
      // End their sessions in this workspace immediately.
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?').run(userId, workspaceId);
    });
  }

  private ownerCount(workspaceId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'").get(workspaceId) as Row).n;
  }

  async createInvitation(i: { id: string; workspaceId: string; tokenHash: string; role: Invitation['role']; email: string | null; createdBy: string; expiresAt: string }): Promise<Invitation> {
    this.db
      .prepare('INSERT INTO invitations (id, workspace_id, token_hash, role, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.id, i.workspaceId, i.tokenHash, i.role, i.email, i.createdBy, nowIso(), i.expiresAt);
    return toInvite(this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(i.id) as Row);
  }

  async listInvitations(workspaceId: string): Promise<Invitation[]> {
    return (this.db.prepare('SELECT * FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100').all(workspaceId) as Row[]).map(toInvite);
  }

  async findInvitation(tokenHash: string): Promise<(Invitation & { workspaceName: string; inviterName: string }) | null> {
    const r = this.db
      .prepare('SELECT i.*, w.name AS workspace_name, u.name AS inviter_name FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?')
      .get(tokenHash) as Row | undefined;
    return r ? { ...toInvite(r), workspaceName: r.workspace_name, inviterName: r.inviter_name } : null;
  }

  async revokeInvitation(workspaceId: string, id: string): Promise<boolean> {
    return this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(nowIso(), id, workspaceId).changes === 1;
  }

  /** Atomically accept: the invitation must still be open, and the user joins with its role (never demoting an existing member). */
  async acceptInvitation(tokenHash: string, userId: string): Promise<{ workspaceId: string; role: Role }> {
    return transaction(this.db, () => {
      const r = this.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash) as Row | undefined;
      if (!r || r.revoked_at || r.accepted_at || r.expires_at <= nowIso()) throw new DomainError('NOT_FOUND', 'This invitation is invalid, expired or already used.');
      const existing = this.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?').get(userId, r.workspace_id) as Row | undefined;
      if (!existing) {
        this.db.prepare('INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?)').run(userId, r.workspace_id, r.role, nowIso());
      }
      this.db.prepare('UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ?').run(userId, nowIso(), r.id);
      return { workspaceId: r.workspace_id as string, role: (existing?.role ?? r.role) as Role };
    });
  }

  async createPasswordReset(tokenHash: string, userId: string, expiresAt: string) {
    this.db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, nowIso(), expiresAt);
  }

  /** Consume a reset token once. Returns the user ID, or null if invalid, expired or used. */
  async consumePasswordReset(tokenHash: string): Promise<string | null> {
    return transaction(this.db, () => {
      const r = this.db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash) as Row | undefined;
      if (!r || r.used_at || r.expires_at <= nowIso()) return null;
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
      return r.user_id as string;
    });
  }

  async passwordHash(userId: string): Promise<string | null> {
    return ((this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined)?.password_hash as string | null) ?? null;
  }

  async setPassword(userId: string, hash: string) {
    this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, nowIso(), userId);
  }

  async updateProfile(userId: string, name: string) {
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
  }

  /** Convert a guest into a full member account, keeping their workspace and history. */
  async upgradeGuest(userId: string, email: string, name: string, hash: string) {
    try {
      transaction(this.db, () => {
        const res = this.db.prepare("UPDATE users SET email = ?, name = ?, password_hash = ?, kind = 'member', password_changed_at = ? WHERE id = ? AND kind = 'guest'").run(email, name, hash, nowIso(), userId);
        if (res.changes !== 1) throw new DomainError('INVALID_TRANSITION', 'Only guest accounts can be upgraded.');
        this.db.prepare("UPDATE workspaces SET kind = 'standard', name = CASE WHEN name = 'Guest workspace' THEN ? ELSE name END WHERE id IN (SELECT workspace_id FROM memberships WHERE user_id = ?)").run(`${name.split(/\s+/)[0]}'s workspace`, userId);
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: users.email/.test(error.message)) {
        throw new DomainError('VALIDATION_FAILED', 'An account with this email already exists. Sign in instead.', { field: 'email' });
      }
      throw error;
    }
  }

  async listSessions(userId: string): Promise<(SessionInfo & { tokenHash: string })[]> {
    return (this.db.prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC').all(userId, nowIso()) as Row[]).map((r) => ({
      id: String(r.token_hash).slice(0, 12),
      tokenHash: r.token_hash,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent ?? null,
      workspaceId: r.workspace_id,
    }));
  }

  async deleteSessionsExcept(userId: string, keepTokenHash: string | null): Promise<number> {
    return Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash ?? '').changes);
  }

  async deleteSessionByHandle(userId: string, handle: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 12) = ?").run(userId, handle).changes > 0;
  }

  async setSessionWorkspace(tokenHash: string, workspaceId: string) {
    this.db.prepare('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?').run(workspaceId, tokenHash);
  }

  async setSessionUserAgent(tokenHash: string, ua: string) {
    this.db.prepare('UPDATE sessions SET user_agent = ? WHERE token_hash = ? AND user_agent IS NULL').run(ua.slice(0, 200), tokenHash);
  }
}
