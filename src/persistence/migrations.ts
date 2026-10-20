/**
 * Versioned, forward-only migrations. Each runs once, inside a transaction,
 * and is recorded in schema_migrations. Never edit an applied migration; add
 * a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_schema',
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  environment TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  failure_reason TEXT,
  failure_action_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX executions_ws_created ON executions (workspace_id, created_at DESC);
CREATE INDEX executions_ws_status ON executions (workspace_id, status);

CREATE TABLE payloads (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  sequence INTEGER NOT NULL,
  adapter_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  input_ref TEXT REFERENCES payloads(id),
  result_ref TEXT REFERENCES payloads(id),
  policy_json TEXT NOT NULL,
  forward_attempts INTEGER NOT NULL DEFAULT 0,
  reconciliation TEXT,
  error_code TEXT,
  error_message TEXT,
  error_effect TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (execution_id, sequence),
  UNIQUE (execution_id, dedupe_key)
);

CREATE TABLE state_snapshots (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  phase TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  captured_state_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX snapshots_action ON state_snapshots (action_id, phase);

CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  request_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  plan_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (execution_id, request_key)
);

CREATE TABLE recovery_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  request_id TEXT NOT NULL REFERENCES recovery_requests(id),
  status TEXT NOT NULL,
  strategy TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  verification_json TEXT,
  error_code TEXT,
  error_message TEXT,
  error_effect TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (action_id, attempt_number)
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rule_type TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resource_locks (
  resource_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

-- Append-only audit history. Ordinary flows cannot rewrite it: UPDATE is
-- always refused and DELETE is refused unless maintenance mode is on (used
-- only by the explicit, confirmed "delete history" operation).
CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL);
INSERT INTO maintenance (id, enabled) VALUES (1, 0);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  execution_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX audit_execution ON audit_events (execution_id, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
WHEN (SELECT enabled FROM maintenance WHERE id = 1) = 0
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`,
  },
  {
    version: 2,
    name: 'home_sim_adapter',
    sql: `
-- Backing store for the local "home-sim" demonstration adapter. Synthetic data only.
CREATE TABLE sim_resources (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);
CREATE TABLE sim_faults (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  mode TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'accounts_and_workspace_scoped_demo',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- Only the SHA-256 of a session token is stored; the token itself lives in an httpOnly cookie.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Only the SHA-256 of an API key is stored; the key is shown once at creation.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_keys_ws ON api_keys (workspace_id);

-- Activation milestones, measured locally. Never sent anywhere.
CREATE TABLE workspace_milestones (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  milestone TEXT NOT NULL,
  reached_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, milestone)
);

ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE workspaces ADD COLUMN onboarding_completed_at TEXT;

-- The demo home becomes per-workspace. Its contents are synthetic and reseeded on demand.
DROP TABLE sim_resources;
DROP TABLE sim_faults;
CREATE TABLE sim_resources (
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, resource_type, resource_id)
);
CREATE TABLE sim_faults (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  mode TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sim_faults_ws ON sim_faults (workspace_id, operation);
`,
  },
  {
    version: 4,
    name: 'teams_security_webhooks',
    sql: `
-- Roles: owner > admin > member > viewer. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE memberships_v4 (
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
INSERT INTO memberships_v4 SELECT user_id, workspace_id, role, created_at FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_v4 RENAME TO memberships;
CREATE INDEX memberships_ws ON memberships (workspace_id);

-- Invitation links. Only the SHA-256 of the token is stored.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  email TEXT COLLATE NOCASE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX invitations_ws ON invitations (workspace_id);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

-- Outbound webhooks. The signing secret is stored because it is needed to sign; it is never returned after creation.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  events_json TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX webhooks_ws ON webhooks (workspace_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  response_code INTEGER,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);

CREATE INDEX actions_execution ON actions (execution_id);
CREATE INDEX recovery_attempts_execution ON recovery_attempts (execution_id);
`,
  },
  {
    version: 5,
    name: 'lockout_mfa_sso',
    sql: `
-- Account lockout.
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- TOTP multi-factor authentication. Secrets are encrypted at rest (AES-256-GCM).
ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT;
ALTER TABLE users ADD COLUMN mfa_pending_enc TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled_at TEXT;
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;

CREATE TABLE mfa_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- A password (or SSO) login that still needs a second factor. Only the token hash is stored.
CREATE TABLE mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Single sign-on: external identities linked to users, keyed by (provider, subject).
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);

-- In-flight OIDC authorization requests (state, nonce, PKCE verifier). Short-lived.
CREATE TABLE sso_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  next TEXT,
  link_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
];
