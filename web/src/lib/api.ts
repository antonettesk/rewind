/**
 * Typed client for the Rewind HTTP API. Response types are imported from the
 * server's own read models, so the UI and backend cannot drift silently.
 */
import type { ExecutionView } from '../../../src/services/queries';
import type { Execution, RecoveryAttempt, RecoveryRequest, StoredPolicy, AuditEvent } from '../../../src/domain/records';
import type { WorkspaceStats } from '../../../src/persistence/repository';
import type { OperationDescriptor, AdapterHealth } from '../../../src/adapters/types';
import type { ActionPolicyResult } from '../../../src/domain/policy';
import type { Scenario } from '../../../src/services/scenarios';
import type { ExecutionStatus, RecoveryOutcome } from '../../../src/domain/status';

export type { ExecutionView, Execution, RecoveryAttempt, RecoveryRequest, StoredPolicy, AuditEvent, Scenario, ExecutionStatus, RecoveryOutcome };
export type ActionView = ExecutionView['actions'][number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export interface AwsStatus {
  region: string | null;
  nova: { enabled: boolean; model: string };
  polly: { enabled: boolean; voice: string; engine: string };
}

export interface NovaPlan {
  steps: { adapter_id: string; operation: string; input: Record<string, unknown>; depends_on: number[]; dedupe_key: string; because: string }[];
  rejected: { operation: string; reason: string }[];
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Rewind server. Is it running?');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('rewind:unauthorized'));
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `Request failed (${res.status})`, e.issues);
  }
  return data as T;
}

export interface ExecutionListItem extends Execution {
  actionCount: number;
  failurePoint: { sequence: number; operation: string } | null;
  adapters: string[];
}

export interface AdapterView {
  id: string;
  name: string;
  type: string;
  version: string;
  description: string;
  disclosure: string;
  connection: string;
  health: AdapterHealth;
  operations: (OperationDescriptor & { policy: ActionPolicyResult })[];
}

export interface RecoveryItem {
  execution: Execution;
  summary: ExecutionView['summary'];
  steps: {
    id: string;
    sequence: number;
    operationKey: string;
    operationTitle: string;
    status: string;
    capability: string;
    recoveryOutcome: RecoveryOutcome;
    recoveryOutcomeReason: string;
    attempts: RecoveryAttempt[];
  }[];
  requests: RecoveryRequest[];
}

export interface SimResource {
  type: string;
  id: string;
  state: { version: number; data: Record<string, any>; meta?: Record<string, unknown> };
}

export interface Settings {
  workspace: { id: string; name: string; kind: string };
  environment: string;
  mcp: { endpoint: string; transport: string; protocolVersions: string[]; session: string; sdk: string };
  auth: { console: string; mcp: string; trustUpstream: string; localOnly: boolean };
  retentionDays: number;
  guestRetentionHours: number;
  email: { provider: string; from: string | null };
  sso: { id: string; name: string }[];
  database: { engine: string; path: string };
  server: { name: string; version: string };
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface WorkspaceInfo {
  id: string;
  name: string;
  kind: 'standard' | 'guest';
  role: Role;
  createdAt: string;
  onboardingCompletedAt: string | null;
}
export interface Me {
  user: { id: string; name: string; email: string | null; kind: 'member' | 'guest'; mfaEnabled: boolean };
  workspace: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  milestones: Record<string, string>;
  via: 'session' | 'api_key';
}
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
  role: Exclude<Role, 'owner'>;
  email: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}
export interface Webhook {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  lastDelivery: WebhookDelivery | null;
}
export interface WebhookDelivery {
  id: string;
  eventType: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}
export interface Usage {
  periodStart: string;
  executions: number;
  mcpExecutions: number;
  verifiedRecoveries: number;
  failedRecoveries: number;
  approvals: number;
  members: number;
  activeApiKeys: number;
  webhooks: number;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  session: () => request<{ signedIn: boolean; me: Me | null }>('GET', '/auth/session'),
  signup: (b: { name: string; email: string; password: string; workspaceName?: string }) => request<{ ok: true }>('POST', '/auth/signup', b),
  login: (b: { email: string; password: string }) => request<{ ok?: true; mfaRequired?: true }>('POST', '/auth/login', b),
  mfaLogin: (code: string) => request<{ ok: true }>('POST', '/auth/mfa', { code }),
  ssoProviders: () => request<{ providers: { id: string; name: string }[] }>('GET', '/auth/sso'),
  mfaStatus: () => request<{ enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number }>('GET', '/account/mfa'),
  mfaSetup: () => request<{ secret: string; uri: string; qr: string }>('POST', '/account/mfa/setup', {}),
  mfaEnable: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/account/mfa/enable', { code }),
  mfaDisable: (code: string, password?: string) => request<{ ok: true }>('POST', '/account/mfa/disable', { code, ...(password ? { password } : {}) }),
  mfaRecoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/account/mfa/recovery-codes', { code }),
  identities: () => request<{ identities: { provider: string; name: string; email: string | null; linkedAt: string; lastLoginAt: string | null }[]; available: { id: string; name: string }[] }>('GET', '/account/identities'),
  linkIdentity: (provider: string) => request<{ url: string }>('POST', `/account/identities/${encodeURIComponent(provider)}`, {}),
  unlinkIdentity: (provider: string) => request<{ ok: true }>('DELETE', `/account/identities/${encodeURIComponent(provider)}`),
  guest: () => request<{ ok: true }>('POST', '/auth/guest', {}),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  renameWorkspace: (name: string) => request<{ ok: true }>('PATCH', '/workspace', { name }),
  completeOnboarding: () => request<{ ok: true }>('POST', '/onboarding/complete', {}),
  keys: () => request<{ keys: ApiKey[] }>('GET', '/keys'),
  createKey: (name: string) => request<{ key: string; record: ApiKey }>('POST', '/keys', { name }),
  revokeKey: (id: string) => request<{ ok: true }>('DELETE', `/keys/${encodeURIComponent(id)}`),
  forgotPassword: (email: string) => request<{ ok: true; message: string }>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => request<{ ok: true }>('POST', '/auth/password/reset', { token, password }),
  previewInvitation: (token: string) => request<{ workspaceName: string; inviterName: string; role: string; valid: boolean; expiresAt: string }>('GET', `/invitations/preview/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string) => request<{ workspaceId: string; role: Role }>('POST', '/invitations/accept', { token }),
  members: () => request<{ members: Member[] }>('GET', '/members'),
  setMemberRole: (userId: string, role: Role) => request<{ ok: true }>('PATCH', `/members/${encodeURIComponent(userId)}`, { role }),
  removeMember: (userId: string) => request<{ ok: true }>('DELETE', `/members/${encodeURIComponent(userId)}`),
  invitations: () => request<{ invitations: Invitation[] }>('GET', '/invitations'),
  createInvitation: (role: Exclude<Role, 'owner'>, email?: string) => request<{ invitation: Invitation; url: string; emailed: boolean; mailer: string }>('POST', '/invitations', { role, ...(email ? { email } : {}) }),
  revokeInvitation: (id: string) => request<{ ok: true }>('DELETE', `/invitations/${encodeURIComponent(id)}`),
  switchWorkspace: (workspaceId: string) => request<{ workspace: WorkspaceInfo }>('POST', '/session/workspace', { workspaceId }),
  deleteWorkspace: (confirmName: string) => request<{ ok: true }>('DELETE', '/workspace', { confirmName }),
  updateProfile: (name: string) => request<{ ok: true }>('PATCH', '/account', { name }),
  changePassword: (current: string, next: string) => request<{ ok: true; otherSessionsSignedOut: number }>('POST', '/account/password', { current, next }),
  upgradeGuest: (b: { name: string; email: string; password: string }) => request<{ ok: true }>('POST', '/account/upgrade', b),
  sessions: () => request<{ sessions: SessionInfo[] }>('GET', '/account/sessions'),
  revokeOtherSessions: () => request<{ signedOut: number }>('POST', '/account/sessions/revoke-others', {}),
  revokeSession: (id: string) => request<{ ok: true }>('DELETE', `/account/sessions/${encodeURIComponent(id)}`),
  webhooks: () => request<{ webhooks: Webhook[]; events: string[] }>('GET', '/webhooks'),
  createWebhook: (b: { url: string; description?: string; events: string[] }) => request<{ webhook: Webhook; secret: string }>('POST', '/webhooks', b),
  setWebhookEnabled: (id: string, enabled: boolean) => request<{ ok: true }>('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled }),
  deleteWebhook: (id: string) => request<{ ok: true }>('DELETE', `/webhooks/${encodeURIComponent(id)}`),
  webhookDeliveries: (id: string) => request<{ deliveries: WebhookDelivery[] }>('GET', `/webhooks/${encodeURIComponent(id)}/deliveries`),
  testWebhook: (id: string) => request<{ delivery: WebhookDelivery }>('POST', `/webhooks/${encodeURIComponent(id)}/test`, {}),
  usage: () => request<Usage>('GET', '/usage'),
  activation: () => request<{ milestones: Record<string, string>; timeToFirstExecutionMs: number | null; timeToFirstVerifiedRecoveryMs: number | null; timeToFirstMcpCallMs: number | null }>('GET', '/activation'),
  health: () => request<{ status: string; database: string; adapters: ({ id: string } & AdapterHealth)[]; startedAt: string; version: string }>('GET', '/health'),
  overview: () =>
    request<{ stats: WorkspaceStats; recentExecutions: Execution[]; recentRecoveryAttempts: (RecoveryAttempt & { taskDescription: string; operation: string; adapterId: string })[]; environment: string }>('GET', '/overview'),
  executions: (q: { status?: string[]; search?: string; cursor?: string; limit?: number }) => {
    const p = new URLSearchParams();
    q.status?.forEach((s) => p.append('status', s));
    if (q.search) p.set('search', q.search);
    if (q.cursor) p.set('cursor', q.cursor);
    p.set('limit', String(q.limit ?? 25));
    return request<{ items: ExecutionListItem[]; nextCursor: string | null }>('GET', `/executions?${p}`);
  },
  execution: (id: string) => request<ExecutionView>('GET', `/executions/${encodeURIComponent(id)}`),
  recover: (id: string, requestKey: string) => request<ExecutionView>('POST', `/executions/${encodeURIComponent(id)}/recover`, { requestKey, confirm: true }),
  approve: (id: string, actionId: string) => request<ExecutionView>('POST', `/executions/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}/approve`, { confirm: true }),
  reject: (id: string, actionId: string, reason: string) => request<ExecutionView>('POST', `/executions/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}/reject`, { reason }),
  cancel: (id: string, reason: string) => request<ExecutionView>('POST', `/executions/${encodeURIComponent(id)}/cancel`, { reason }),
  recovery: () => request<{ items: RecoveryItem[]; attempts: (RecoveryAttempt & { taskDescription: string; operation: string; adapterId: string })[] }>('GET', '/recovery'),
  adapters: () => request<{ adapters: AdapterView[] }>('GET', '/adapters'),
  policies: () => request<{ policies: StoredPolicy[] }>('GET', '/policies'),
  updatePolicy: (id: string, body: { version: number; enabled?: boolean; configuration?: Record<string, unknown> }) => request<{ policy: StoredPolicy }>('PATCH', `/policies/${encodeURIComponent(id)}`, body),
  scenarios: () => request<{ scenarios: Scenario[] }>('GET', '/demo/scenarios'),
  demoState: () => request<{ resources: SimResource[]; faults: { id: string; operation: string; mode: string; remaining: number }[]; locks: { resourceKey: string; executionId: string }[] }>('GET', '/demo/state'),
  runScenario: (id: string, injectFaults: boolean) => request<ExecutionView>('POST', `/demo/scenarios/${encodeURIComponent(id)}/run`, { injectFaults }),
  armFault: (operation: string, mode: string) => request<unknown>('POST', '/demo/faults', { operation, mode }),
  clearFaults: () => request<unknown>('DELETE', '/demo/faults'),
  aws: () => request<AwsStatus>('GET', '/aws'),
  novaPlan: (requestText: string) => request<NovaPlan>('POST', '/agent/plan', { request: requestText }),
  executionSummary: (executionId: string) => request<{ text: string }>('GET', `/executions/${encodeURIComponent(executionId)}/summary`),
  voiceUrl: (executionId: string) => `/api/executions/${encodeURIComponent(executionId)}/voice.mp3`,
  reset: (clearHistory: boolean) => request<{ executionsDeleted: number }>('POST', '/demo/reset', { confirm: 'RESET', clearHistory }),
  purge: () => request<{ executions: number }>('POST', '/retention/purge', { confirm: 'PURGE' }),
  settings: () => request<Settings>('GET', '/settings'),
  audit: (limit = 50) => request<{ events: AuditEvent[] }>('GET', `/audit?limit=${limit}`),
  reportUrl: (id: string, format: 'md' | 'json') => `/api/executions/${encodeURIComponent(id)}/report${format === 'json' ? '?format=json' : ''}`,
};

/** Subscribe to server-sent engine events. Returns an unsubscribe function. */
export function subscribe(path: string, onUpdate: (e: { executionId: string; eventType: string; seq: number }) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const es = new EventSource(`/api${path}`);
  es.addEventListener('update', (m) => {
    try {
      onUpdate(JSON.parse((m as MessageEvent).data));
    } catch {
      /* ignore malformed frames */
    }
  });
  return () => es.close();
}
