/**
 * Accounts, sessions, API keys and activation milestones.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1) with a per-user salt, compared in constant time.
 * - Sessions: random 256-bit tokens in an httpOnly, SameSite=Lax cookie; only their SHA-256 is stored.
 * - API keys: random 256-bit `rwk_…` secrets shown once; only their SHA-256 is stored. They scope MCP and API calls to one workspace.
 * - Guests: a password-less account with its own workspace, for trying the product without signing up.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { DomainError } from '../domain/errors.js';
import { newId, sha256 } from '../domain/util.js';
import type { AccountStore, ApiKeyRecord, User, WorkspaceSummary } from '../persistence/accounts.js';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MEMBER_SESSION_MS = 7 * 24 * 3600_000;
const GUEST_SESSION_MS = 24 * 3600_000;
export const SESSION_COOKIE = 'rewind_session';

export const MILESTONES = ['workspace_created', 'first_execution', 'first_verified_recovery', 'first_api_key', 'first_mcp_call', 'first_invite', 'onboarding_completed'] as const;
export type Milestone = (typeof MILESTONES)[number];

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}


export interface AuthContext {
  user: User;
  workspace: WorkspaceSummary;
  via: 'session' | 'api_key';
  apiKeyId?: string;
}

export class AccountService {
  constructor(
    private readonly store: AccountStore,
    /** Seeds policies and the demo home for a new workspace. */
    private readonly provision: (workspaceId: string) => Promise<void>,
  ) {}

  async signup(input: { name: string; email: string; password: string; workspaceName?: string }) {
    const userId = newId('usr');
    const workspaceId = newId('ws');
    await this.store.createUserWithWorkspace(
      { userId, email: input.email.trim().toLowerCase(), name: input.name.trim(), passwordHash: await hashPassword(input.password), kind: 'member' },
      { id: workspaceId, name: input.workspaceName?.trim() || `${input.name.trim().split(/\s+/)[0]}'s workspace`, kind: 'standard' },
    );
    await this.provision(workspaceId);
    await this.store.recordMilestone(workspaceId, 'workspace_created');
    return this.startSession(userId, workspaceId, MEMBER_SESSION_MS);
  }

  async guest() {
    const userId = newId('usr');
    const workspaceId = newId('ws');
    await this.store.createUserWithWorkspace({ userId, email: null, name: 'Guest', passwordHash: null, kind: 'guest' }, { id: workspaceId, name: 'Guest workspace', kind: 'guest' });
    await this.provision(workspaceId);
    await this.store.recordMilestone(workspaceId, 'workspace_created');
    return this.startSession(userId, workspaceId, GUEST_SESSION_MS);
  }

  /** Start a member session in the user's first workspace (after password/MFA or SSO succeeded). */
  async sessionForUser(userId: string) {
    const [ws] = await this.store.listWorkspaces(userId);
    if (!ws) throw new DomainError('FORBIDDEN', 'This account has no workspace.');
    await this.store.touchLogin(userId);
    return this.startSession(userId, ws.id, MEMBER_SESSION_MS);
  }

  /** Create an account for a first-time SSO user (no password), with its own provisioned workspace. */
  async createSsoUser(email: string | null, name: string) {
    const userId = newId('usr');
    const workspaceId = newId('ws');
    await this.store.createUserWithWorkspace(
      { userId, email: email?.toLowerCase() ?? null, name, passwordHash: null, kind: 'member' },
      { id: workspaceId, name: `${name.split(/\s+/)[0]}'s workspace`, kind: 'standard' },
    );
    await this.provision(workspaceId);
    await this.store.recordMilestone(workspaceId, 'workspace_created');
    return userId;
  }

  findUserByEmail(email: string) {
    return this.store.findUserByEmail(email.trim().toLowerCase());
  }

  getUser(id: string) {
    return this.store.getUser(id);
  }

  private async startSession(userId: string, workspaceId: string, ttlMs: number) {
    const token = `rws_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.store.createSession({ tokenHash: sha256(token), userId, workspaceId, expiresAt: expiresAt.toISOString() });
    return { token, expiresAt };
  }

  /** A full (non-guest) account by email, for password resets. */
  async findMember(email: string) {
    const u = await this.store.findUserByEmail(email.trim().toLowerCase());
    return u && u.kind === 'member' && u.email ? u : null;
  }

  async logout(token: string) {
    await this.store.deleteSession(sha256(token));
  }

  async fromSession(token: string): Promise<AuthContext | null> {
    if (!token.startsWith('rws_')) return null;
    const hash = sha256(token);
    const s = await this.store.findSession(hash);
    if (!s) return null;
    const ctx = await this.resolve(s.userId, s.workspaceId);
    if (ctx) await this.store.touchSession(hash);
    return ctx ? { ...ctx, via: 'session' } : null;
  }

  async fromApiKey(key: string): Promise<AuthContext | null> {
    if (!key.startsWith('rwk_')) return null;
    const rec = await this.store.findApiKey(sha256(key));
    if (!rec) return null;
    const ctx = await this.resolve(rec.createdBy, rec.workspaceId);
    if (!ctx) return null;
    await this.store.touchApiKey(rec.id);
    // Keys act for agents: capped at "member" (they can run and recover, never approve or administer).
    const role = ctx.workspace.role === 'viewer' ? 'viewer' : 'member';
    return { ...ctx, workspace: { ...ctx.workspace, role }, via: 'api_key', apiKeyId: rec.id };
  }

  private async resolve(userId: string, workspaceId: string) {
    const user = await this.store.getUser(userId);
    if (!user) return null;
    const workspace = (await this.store.listWorkspaces(userId)).find((w) => w.id === workspaceId);
    return workspace ? { user, workspace } : null;
  }

  async createApiKey(ctx: AuthContext, name: string): Promise<{ key: string; record: ApiKeyRecord }> {
    if (ctx.via !== 'session') throw new DomainError('FORBIDDEN', 'API keys can only be created from a signed-in console session.');
    const existing = (await this.store.listApiKeys(ctx.workspace.id)).filter((k) => !k.revokedAt);
    if (existing.length >= 10) throw new DomainError('LIMIT_EXCEEDED', 'A workspace can have at most 10 active API keys. Revoke one first.');
    const key = `rwk_${randomBytes(32).toString('base64url')}`;
    const record = await this.store.createApiKey({ id: newId('key'), workspaceId: ctx.workspace.id, name, prefix: key.slice(0, 12), keyHash: sha256(key), createdBy: ctx.user.id });
    await this.milestone(ctx.workspace.id, 'first_api_key');
    return { key, record };
  }

  listApiKeys(workspaceId: string) {
    return this.store.listApiKeys(workspaceId);
  }

  async revokeApiKey(ctx: AuthContext, id: string) {
    if (ctx.via !== 'session') throw new DomainError('FORBIDDEN', 'API keys can only be revoked from a signed-in console session.');
    if (!(await this.store.revokeApiKey(ctx.workspace.id, id))) throw new DomainError('NOT_FOUND', 'No active key with that ID in this workspace.');
  }

  renameWorkspace(workspaceId: string, name: string) {
    return this.store.renameWorkspace(workspaceId, name);
  }

  async completeOnboarding(workspaceId: string) {
    await this.store.completeOnboarding(workspaceId);
    await this.milestone(workspaceId, 'onboarding_completed');
  }

  milestone(workspaceId: string, m: Milestone) {
    return this.store.recordMilestone(workspaceId, m);
  }

  milestones(workspaceId: string) {
    return this.store.listMilestones(workspaceId);
  }

  workspaces(userId: string) {
    return this.store.listWorkspaces(userId);
  }

  /** Guest workspaces are temporary: removed with their history after the cutoff. */
  guestWorkspacesOlderThan(cutoffIso: string) {
    return this.store.listGuestWorkspacesOlderThan(cutoffIso);
  }

  deleteWorkspaceIdentity(workspaceId: string) {
    return this.store.deleteWorkspaceIdentity(workspaceId);
  }

  deleteExpiredSessions() {
    return this.store.deleteExpiredSessions();
  }
}
