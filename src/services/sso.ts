/**
 * Single sign-on with OpenID Connect (authorization code flow + PKCE).
 *
 * Supported out of the box: Google, Microsoft Entra ID, and any standards-
 * compliant OIDC provider (Okta, Auth0, Keycloak, Cognito…) via the generic slot.
 *
 * Safety rules:
 *  - `state` (one-time, 10 minutes, stored hashed), `nonce` and a PKCE verifier on every request.
 *  - ID tokens are verified against the provider's JWKS: signature, issuer, audience, expiry, nonce.
 *  - Identities are keyed by (provider, subject), never by email alone.
 *  - An existing password account is linked by email only when the provider asserts
 *    `email_verified: true`; otherwise the person must sign in and link from settings.
 *  - Accounts with MFA still complete the TOTP step after SSO.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { DomainError } from '../domain/errors.js';
import { nowIso, sha256 } from '../domain/util.js';
import type { Db } from '../persistence/db.js';
import type { AccountService } from './accounts.js';

export interface SsoProviderConfig {
  id: 'google' | 'microsoft' | 'oidc';
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Microsoft "common"/"organizations": the issuer contains a {tenantid} placeholder. */
  multiTenant?: boolean;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const STATE_TTL_MS = 10 * 60_000;
type Row = Record<string, any>;

export class SsoService {
  private readonly discovery = new Map<string, { doc: Discovery; at: number; jwks: ReturnType<typeof createRemoteJWKSet> }>();

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountService,
    private readonly providers: SsoProviderConfig[],
    private readonly publicUrl: string,
    private readonly opts: { allowInsecureIssuer: boolean },
  ) {}

  list() {
    return this.providers.map((p) => ({ id: p.id, name: p.name }));
  }

  private provider(id: string): SsoProviderConfig {
    const p = this.providers.find((x) => x.id === id);
    if (!p) throw new DomainError('NOT_FOUND', `Single sign-on with "${id}" is not configured on this server.`);
    return p;
  }

  redirectUri(id: string) {
    return `${this.publicUrl}/api/auth/sso/${id}/callback`;
  }

  private async discover(p: SsoProviderConfig) {
    const cached = this.discovery.get(p.id);
    if (cached && Date.now() - cached.at < 3_600_000) return cached;
    const issuer = new URL(p.issuer);
    if (issuer.protocol !== 'https:' && !this.opts.allowInsecureIssuer) throw new DomainError('VALIDATION_FAILED', 'OIDC issuers must use HTTPS.');
    const res = await fetch(`${p.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new DomainError('INTERNAL', `Could not load ${p.name} sign-in configuration (HTTP ${res.status}).`);
    const doc = (await res.json()) as Discovery;
    const entry = { doc, at: Date.now(), jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
    this.discovery.set(p.id, entry);
    return entry;
  }

  /** Build the provider's authorization URL and remember state, nonce and PKCE verifier. */
  async start(providerId: string, opts: { next?: string | null; linkUserId?: string | null } = {}) {
    const p = this.provider(providerId);
    const { doc } = await this.discover(p);
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const next = opts.next && opts.next.startsWith('/') && !opts.next.startsWith('//') ? opts.next : null;
    this.db
      .prepare('INSERT INTO sso_states (state_hash, provider, nonce, code_verifier, next, link_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(state), p.id, nonce, verifier, next, opts.linkUserId ?? null, nowIso(), new Date(Date.now() + STATE_TTL_MS).toISOString());
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: p.clientId,
      redirect_uri: this.redirectUri(p.id),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(p.id === 'google' ? { prompt: 'select_account' } : {}),
    }).toString();
    return url.toString();
  }

  /** Handle the redirect back from the provider. Returns the Rewind user to sign in. */
  async callback(providerId: string, q: { code?: string; state?: string; error?: string; error_description?: string }) {
    const p = this.provider(providerId);
    if (q.error) throw new DomainError('UNAUTHORIZED', `${p.name} sign-in was cancelled or refused: ${q.error_description ?? q.error}.`);
    if (!q.code || !q.state) throw new DomainError('VALIDATION_FAILED', 'The sign-in response was incomplete.');
    const st = this.db.prepare('SELECT * FROM sso_states WHERE state_hash = ? AND provider = ?').get(sha256(q.state), p.id) as Row | undefined;
    this.db.prepare('DELETE FROM sso_states WHERE state_hash = ?').run(sha256(q.state));
    if (!st || st.expires_at <= nowIso()) throw new DomainError('UNAUTHORIZED', 'This sign-in link expired. Start again.');

    const { doc, jwks } = await this.discover(p);
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: this.redirectUri(p.id), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: st.code_verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!tokenRes.ok || !tokens.id_token) throw new DomainError('UNAUTHORIZED', `${p.name} did not return an ID token${tokens.error ? ` (${tokens.error})` : ''}.`);

    let claims: JWTPayload & { email?: string; email_verified?: boolean; name?: string; nonce?: string; tid?: string; preferred_username?: string };
    try {
      const verified = await jwtVerify(tokens.id_token, jwks, { audience: p.clientId, ...(p.multiTenant ? {} : { issuer: doc.issuer }), clockTolerance: 60 });
      claims = verified.payload as typeof claims;
    } catch (error) {
      throw new DomainError('UNAUTHORIZED', `The ${p.name} ID token could not be verified: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (p.multiTenant) {
      const expected = doc.issuer.replace('{tenantid}', String(claims.tid ?? ''));
      if (!claims.tid || claims.iss !== expected) throw new DomainError('UNAUTHORIZED', 'The ID token issuer does not match its tenant.');
    }
    if (claims.nonce !== st.nonce) throw new DomainError('UNAUTHORIZED', 'The sign-in response did not match this request (nonce).');
    if (!claims.sub) throw new DomainError('UNAUTHORIZED', 'The ID token has no subject.');

    const email = (claims.email ?? (p.id === 'microsoft' ? claims.preferred_username : undefined))?.toLowerCase() ?? null;
    const verifiedEmail = claims.email_verified === true;
    const name = (claims.name ?? email?.split('@')[0] ?? `${p.name} user`).slice(0, 80);
    const existing = this.db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(p.id, claims.sub) as Row | undefined;

    let userId: string;
    let isNew = false;
    if (st.link_user_id) {
      if (existing && existing.user_id !== st.link_user_id) throw new DomainError('VALIDATION_FAILED', `This ${p.name} account is already connected to a different Rewind user.`);
      userId = st.link_user_id;
    } else if (existing) {
      userId = existing.user_id;
    } else {
      const byEmail = email ? await this.accounts.findUserByEmail(email) : null;
      if (byEmail && byEmail.kind === 'member') {
        if (!verifiedEmail) {
          throw new DomainError('UNAUTHORIZED', `An account with ${email} already exists. Sign in with your password, then connect ${p.name} under Account settings.`);
        }
        userId = byEmail.id;
      } else {
        userId = await this.accounts.createSsoUser(email && !byEmail ? email : null, name);
        isNew = true;
      }
    }
    this.db
      .prepare('INSERT INTO identities (provider, subject, user_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET last_login_at = excluded.last_login_at, email = excluded.email')
      .run(p.id, claims.sub, userId, email, nowIso(), nowIso());
    return { userId, next: st.next as string | null, isNew, linked: Boolean(st.link_user_id), provider: p.name };
  }

  identities(userId: string) {
    return (this.db.prepare('SELECT provider, email, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY created_at').all(userId) as Row[]).map((r) => ({
      provider: r.provider as string,
      name: this.providers.find((p) => p.id === r.provider)?.name ?? r.provider,
      email: r.email ?? null,
      linkedAt: r.created_at,
      lastLoginAt: r.last_login_at ?? null,
    }));
  }

  unlink(userId: string, provider: string) {
    const hasPassword = Boolean((this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined)?.password_hash);
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?').get(userId) as Row).n;
    if (!hasPassword && count <= 1) throw new DomainError('INVALID_TRANSITION', 'Set a password first (use "Forgot password"), or you would be locked out of this account.');
    if (this.db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').run(userId, provider).changes === 0) throw new DomainError('NOT_FOUND', 'That sign-in method is not connected.');
  }
}

/** Read SSO providers from the environment. A provider is enabled when its client ID and secret are set. */
export function ssoProvidersFromEnv(env: NodeJS.ProcessEnv): SsoProviderConfig[] {
  const out: SsoProviderConfig[] = [];
  if (env.REWIND_SSO_GOOGLE_CLIENT_ID && env.REWIND_SSO_GOOGLE_CLIENT_SECRET) {
    out.push({ id: 'google', name: 'Google', issuer: 'https://accounts.google.com', clientId: env.REWIND_SSO_GOOGLE_CLIENT_ID, clientSecret: env.REWIND_SSO_GOOGLE_CLIENT_SECRET });
  }
  if (env.REWIND_SSO_MICROSOFT_CLIENT_ID && env.REWIND_SSO_MICROSOFT_CLIENT_SECRET) {
    const tenant = env.REWIND_SSO_MICROSOFT_TENANT || 'common';
    out.push({
      id: 'microsoft',
      name: 'Microsoft',
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      clientId: env.REWIND_SSO_MICROSOFT_CLIENT_ID,
      clientSecret: env.REWIND_SSO_MICROSOFT_CLIENT_SECRET,
      multiTenant: ['common', 'organizations', 'consumers'].includes(tenant),
    });
  }
  if (env.REWIND_SSO_OIDC_ISSUER && env.REWIND_SSO_OIDC_CLIENT_ID && env.REWIND_SSO_OIDC_CLIENT_SECRET) {
    out.push({ id: 'oidc', name: env.REWIND_SSO_OIDC_NAME || 'SSO', issuer: env.REWIND_SSO_OIDC_ISSUER, clientId: env.REWIND_SSO_OIDC_CLIENT_ID, clientSecret: env.REWIND_SSO_OIDC_CLIENT_SECRET });
  }
  return out;
}
