/**
 * Teams and account security on top of AccountService.
 *
 * Role rules (enforced here, not in the UI):
 *  - owner:  everything, including deleting the workspace and granting ownership
 *  - admin:  members, invitations, policies, API keys, webhooks; cannot touch owners or grant ownership
 *  - member: run executions and demos, request recovery
 *  - viewer: read-only
 * Approving a gated step requires admin or owner (separation of duties: the
 * person who runs an agent is not automatically the person who approves it).
 */
import { randomBytes } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import { newId, sha256 } from '../domain/util.js';
import type { Repository } from '../persistence/repository.js';
import { ROLE_RANK, type Role, type SqliteTeamStore } from '../persistence/teams.js';
import { hashPassword, verifyPassword, type AccountService, type AuthContext } from './accounts.js';
import type { Mailer } from './mailer.js';
import { emailTemplate } from './email-templates.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;

export function hasRole(role: Role, min: Role) {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function requireRole(ctx: AuthContext, min: Role) {
  if (!hasRole(ctx.workspace.role as Role, min)) {
    throw new DomainError('FORBIDDEN', `This action needs the ${min} role or higher. Your role in this workspace is ${ctx.workspace.role}.`);
  }
}

export class TeamService {
  constructor(
    private readonly store: SqliteTeamStore,
    private readonly accounts: AccountService,
    private readonly repo: Repository,
    private readonly mailer: Mailer,
    private readonly publicUrl: string,
  ) {}

  // ── Members ──
  members(workspaceId: string) {
    return this.store.listMembers(workspaceId);
  }

  async setRole(ctx: AuthContext, userId: string, role: Role) {
    requireRole(ctx, 'admin');
    const target = await this.store.roleOf(userId, ctx.workspace.id);
    if (!target) throw new DomainError('NOT_FOUND', 'That person is not a member of this workspace.');
    if ((target === 'owner' || role === 'owner') && ctx.workspace.role !== 'owner') {
      throw new DomainError('FORBIDDEN', 'Only an owner can grant or change ownership.');
    }
    await this.store.setRole(ctx.workspace.id, userId, role);
  }

  async removeMember(ctx: AuthContext, userId: string) {
    if (userId !== ctx.user.id) requireRole(ctx, 'admin');
    const target = await this.store.roleOf(userId, ctx.workspace.id);
    if (target === 'owner' && ctx.workspace.role !== 'owner') throw new DomainError('FORBIDDEN', 'Only an owner can remove an owner.');
    await this.store.removeMember(ctx.workspace.id, userId);
  }

  // ── Invitations ──
  async invite(ctx: AuthContext, role: Exclude<Role, 'owner'>, email: string | null) {
    requireRole(ctx, 'admin');
    if (ctx.workspace.kind === 'guest') throw new DomainError('FORBIDDEN', 'Guest workspaces cannot invite people. Create an account first.');
    const token = `rwi_${randomBytes(24).toString('base64url')}`;
    const invitation = await this.store.createInvitation({
      id: newId('evt').replace('evt_', 'inv_'),
      workspaceId: ctx.workspace.id,
      tokenHash: sha256(token),
      role,
      email,
      createdBy: ctx.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    });
    const url = `${this.publicUrl}/invite/${token}`;
    if (email) {
      await this.mailer.send(
        emailTemplate({
          to: email,
          subject: `${ctx.user.name} invited you to ${ctx.workspace.name} on REWIND`,
          heading: `Join ${ctx.workspace.name} on REWIND`,
          body: [`${ctx.user.name} invited you to join "${ctx.workspace.name}" as ${role}.`, 'REWIND records, contains and verifiably recovers what AI agents do with your tools.'],
          action: { label: 'Accept invitation', url },
          footnote: 'This link works once and expires in 7 days. If you were not expecting it, you can ignore this email.',
        }),
      );
    }
    return { invitation, url };
  }

  invitations(workspaceId: string) {
    return this.store.listInvitations(workspaceId);
  }

  async revokeInvitation(ctx: AuthContext, id: string) {
    requireRole(ctx, 'admin');
    if (!(await this.store.revokeInvitation(ctx.workspace.id, id))) throw new DomainError('NOT_FOUND', 'No open invitation with that ID.');
  }

  async previewInvitation(token: string) {
    const inv = await this.store.findInvitation(sha256(token));
    if (!inv) return null;
    const valid = !inv.revokedAt && !inv.acceptedAt && inv.expiresAt > new Date().toISOString();
    return { workspaceName: inv.workspaceName, inviterName: inv.inviterName, role: inv.role, valid, expiresAt: inv.expiresAt };
  }

  async acceptInvitation(ctx: AuthContext, token: string, sessionToken: string | null) {
    if (ctx.user.kind === 'guest') throw new DomainError('FORBIDDEN', 'Create an account (or sign in) to accept an invitation.');
    const r = await this.store.acceptInvitation(sha256(token), ctx.user.id);
    if (sessionToken) await this.store.setSessionWorkspace(sha256(sessionToken), r.workspaceId);
    return r;
  }

  // ── Workspace switching ──
  async switchWorkspace(ctx: AuthContext, sessionToken: string, workspaceId: string) {
    const ws = (await this.accounts.workspaces(ctx.user.id)).find((w) => w.id === workspaceId);
    if (!ws) throw new DomainError('NOT_FOUND', 'You are not a member of that workspace.');
    await this.store.setSessionWorkspace(sha256(sessionToken), workspaceId);
    return ws;
  }

  // ── Profile & password ──
  async updateProfile(ctx: AuthContext, name: string) {
    await this.store.updateProfile(ctx.user.id, name);
  }

  async changePassword(ctx: AuthContext, current: string, next: string, sessionToken: string | null) {
    const hash = await this.store.passwordHash(ctx.user.id);
    if (!hash || !(await verifyPassword(current, hash))) throw new DomainError('UNAUTHORIZED', 'Your current password is incorrect.');
    await this.store.setPassword(ctx.user.id, await hashPassword(next));
    // Every other session is signed out; this one stays.
    return this.store.deleteSessionsExcept(ctx.user.id, sessionToken ? sha256(sessionToken) : null);
  }

  /** Always succeeds from the caller's point of view, so it does not reveal which emails have accounts. */
  async requestPasswordReset(email: string) {
    const user = await this.accounts.findMember(email);
    if (!user) return;
    const token = `rwr_${randomBytes(24).toString('base64url')}`;
    await this.store.createPasswordReset(sha256(token), user.id, new Date(Date.now() + RESET_TTL_MS).toISOString());
    const url = `${this.publicUrl}/reset-password?token=${token}`;
    await this.mailer.send(
      emailTemplate({
        to: user.email!,
        subject: 'Reset your REWIND password',
        heading: 'Reset your password',
        body: [`Someone asked to reset the password for ${user.email}.`, 'The link below works once and expires in 30 minutes. Resetting signs out every session and unlocks the account.'],
        action: { label: 'Choose a new password', url },
        footnote: "If this wasn't you, ignore this email; your password stays the same.",
      }),
    );
  }

  async resetPassword(token: string, password: string) {
    const userId = await this.store.consumePasswordReset(sha256(token));
    if (!userId) throw new DomainError('NOT_FOUND', 'This reset link is invalid, expired or already used. Request a new one.');
    await this.store.setPassword(userId, await hashPassword(password));
    await this.store.deleteSessionsExcept(userId, null);
    return userId;
  }

  async upgradeGuest(ctx: AuthContext, input: { name: string; email: string; password: string }) {
    if (ctx.user.kind !== 'guest') throw new DomainError('INVALID_TRANSITION', 'This account is already a full account.');
    await this.store.upgradeGuest(ctx.user.id, input.email.trim().toLowerCase(), input.name.trim(), await hashPassword(input.password));
  }

  // ── Sessions ──
  async sessions(ctx: AuthContext, currentToken: string | null) {
    const current = currentToken ? sha256(currentToken) : null;
    return (await this.store.listSessions(ctx.user.id)).map(({ tokenHash, ...s }) => ({ ...s, current: tokenHash === current }));
  }

  revokeOtherSessions(ctx: AuthContext, currentToken: string | null) {
    return this.store.deleteSessionsExcept(ctx.user.id, currentToken ? sha256(currentToken) : null);
  }

  async revokeSession(ctx: AuthContext, handle: string) {
    if (!(await this.store.deleteSessionByHandle(ctx.user.id, handle))) throw new DomainError('NOT_FOUND', 'No such session.');
  }

  recordUserAgent(sessionToken: string, ua: string) {
    return this.store.setSessionUserAgent(sha256(sessionToken), ua);
  }

  // ── Danger zone ──
  async deleteWorkspace(ctx: AuthContext, confirmName: string) {
    requireRole(ctx, 'owner');
    if (confirmName !== ctx.workspace.name) throw new DomainError('VALIDATION_FAILED', 'Type the workspace name exactly to confirm.');
    await this.repo.purgeWorkspaceHistory(ctx.workspace.id);
    await this.accounts.deleteWorkspaceIdentity(ctx.workspace.id);
  }
}
