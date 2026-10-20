/**
 * Composition root. Wires persistence, adapters, engine, accounts and read
 * models. HTTP and MCP layers receive this object and never construct domain
 * parts themselves.
 */
import { AdapterRegistry } from '../adapters/registry.js';
import { createHomeSimAdapter } from '../adapters/home-sim/adapter.js';
import { HomeSimStore, type FaultMode, FAULT_MODES } from '../adapters/home-sim/store.js';
import type { Config } from '../config.js';
import { DomainError } from '../domain/errors.js';
import type { Actor } from '../domain/records.js';
import { Engine, type CallContext, type EngineEvent } from '../engine/engine.js';
import { createLogger, type Logger } from '../logger.js';
import { SqliteAccountStore } from '../persistence/accounts.js';
import { openDatabase, type Db } from '../persistence/db.js';
import { SqliteRepository, type Repository } from '../persistence/repository.js';
import { AccountService } from './accounts.js';
import { LogMailer, ResendMailer, type Mailer } from './mailer.js';
import { SecretBox } from './crypto.js';
import { SecurityService } from './security.js';
import { SsoService } from './sso.js';
import { TeamService } from './team.js';
import { WebhookService } from './webhooks.js';
import { SqliteTeamStore } from '../persistence/teams.js';
import { Metrics } from './metrics.js';
import { DEFAULT_POLICIES, LOCAL_WORKSPACE } from './defaults.js';
import { Queries } from './queries.js';
import { getScenario, SCENARIOS } from './scenarios.js';

export interface App {
  config: Config;
  db: Db;
  repo: Repository;
  registry: AdapterRegistry;
  engine: Engine;
  queries: Queries;
  homeStore: HomeSimStore;
  accounts: AccountService;
  team: TeamService;
  webhooks: WebhookService;
  mailer: Mailer;
  metrics: Metrics;
  security: SecurityService;
  sso: SsoService;
  log: Logger;
  startedAt: string;
  demo: DemoService;
  close(): void;
}

export async function createApp(config: Config, opts: { logger?: Logger; mailer?: Mailer } = {}): Promise<App> {
  const log = opts.logger ?? createLogger(config.logLevel);
  const db = openDatabase(config.dbPath);
  const repo = new SqliteRepository(db);
  const homeStore = new HomeSimStore(db);

  const registry = new AdapterRegistry();
  registry.register(createHomeSimAdapter(homeStore, { timeoutMs: config.demoTimeoutMs }));

  const provision = async (workspaceId: string) => {
    await seedPolicies(repo, workspaceId);
    homeStore.ensureSeeded(workspaceId);
  };

  // The built-in workspace used by tests, scripts and trusted-upstream deployments.
  await repo.ensureWorkspace(LOCAL_WORKSPACE.id, LOCAL_WORKSPACE.name);
  await provision(LOCAL_WORKSPACE.id);

  const engine = new Engine(repo, registry, log, config.environment);
  const interrupted = await engine.reconcileInterrupted();
  if (interrupted) log.warn('startup.reconciled_interrupted_executions', { count: interrupted });

  const accounts = new AccountService(new SqliteAccountStore(db), provision);

  // Activation milestones, derived from real engine events. Local only.
  engine.events.on('event', (e: EngineEvent) => {
    const record = (m: Parameters<AccountService['milestone']>[1]) => void accounts.milestone(e.workspaceId, m).catch(() => undefined);
    if (e.eventType === 'execution.created') record('first_execution');
    if (e.eventType === 'execution.created' && e.actorType === 'mcp_client') record('first_mcp_call');
    if (e.eventType === 'execution.status_changed' && e.payload.to === 'recovered') record('first_verified_recovery');
  });

  const mailer = opts.mailer ?? (config.resendApiKey ? new ResendMailer(config.resendApiKey, config.mailFrom, log) : new LogMailer(log));
  const box = SecretBox.load({ envKey: config.secretKey, dbPath: config.dbPath });
  const security = new SecurityService(db, accounts, box, mailer, config.publicUrl);
  const sso = new SsoService(db, accounts, config.ssoProviders, config.publicUrl, { allowInsecureIssuer: config.localOnly });
  const team = new TeamService(new SqliteTeamStore(db), accounts, repo, mailer, config.publicUrl);
  const webhooks = new WebhookService(db, log, { allowPrivate: config.allowPrivateWebhooks, publicUrl: config.publicUrl });
  const metrics = new Metrics();
  engine.events.on('event', (e: EngineEvent) => {
    metrics.onEngineEvent(e);
    webhooks.onEngineEvent(e, (ws, id) => repo.getExecution(ws, id));
  });

  const queries = new Queries(repo, registry);
  const demo = new DemoService(engine, homeStore, repo);
  return { config, db, repo, registry, engine, queries, homeStore, accounts, team, webhooks, mailer, metrics, security, sso, log, startedAt: new Date().toISOString(), demo, close: () => db.close() };
}

export async function seedPolicies(repo: Repository, workspaceId: string) {
  const existing = new Set((await repo.listPolicies(workspaceId)).map((p) => p.id));
  for (const p of DEFAULT_POLICIES) {
    const id = `${p.id}_${workspaceId}`;
    if (!existing.has(id)) await repo.insertPolicy({ ...p, id, workspaceId });
  }
}

export class DemoService {
  constructor(
    private readonly engine: Engine,
    private readonly store: HomeSimStore,
    private readonly repo: Repository,
  ) {}

  scenarios() {
    return SCENARIOS;
  }

  /** Arm a scenario's faults in this workspace, create its execution and run it through the real engine. */
  async runScenario(ctx: CallContext, scenarioId: string, opts: { injectFaults?: boolean; idempotencyKey?: string } = {}) {
    const scenario = getScenario(scenarioId);
    if (!scenario) throw new DomainError('NOT_FOUND', `Unknown scenario "${scenarioId}".`);
    const ws = ctx.workspaceId;
    const inject = opts.injectFaults ?? true;
    this.store.ensureSeeded(ws);
    this.store.clearFaults(ws);
    if (inject) for (const f of scenario.faults) this.store.armFault(ws, f.operation, f.mode, f.count ?? 1);
    const { execution } = await this.engine.createExecution(ctx, {
      taskDescription: scenario.request,
      idempotencyKey: opts.idempotencyKey,
      plan: scenario.steps,
      source: 'demo-scenario',
      metadata: { demo: true, scenarioId, faultsInjected: inject ? scenario.faults : [] },
    });
    return this.engine.runPlan(ctx, execution.id);
  }

  armFault(ws: string, operation: string, mode: string, count = 1) {
    if (!FAULT_MODES.includes(mode as FaultMode)) throw new DomainError('VALIDATION_FAILED', `Unknown fault mode "${mode}".`);
    return this.store.armFault(ws, operation, mode as FaultMode, count);
  }

  faults(ws: string) {
    return this.store.listFaults(ws);
  }

  clearFaults(ws: string) {
    this.store.clearFaults(ws);
  }

  resources(ws: string) {
    this.store.ensureSeeded(ws);
    return this.store.listResources(ws);
  }

  /** Reset this workspace's synthetic home; optionally delete its execution history too. Both explicit, confirmed operations. */
  async reset(workspaceId: string, actor: Actor, opts: { clearHistory: boolean }) {
    const locks = await this.repo.listLocks(workspaceId);
    if (locks.length) throw new DomainError('RESOURCE_LOCKED', 'An execution is still active. Wait for it to finish before resetting.');
    this.store.reset(workspaceId);
    let purged = 0;
    if (opts.clearHistory) purged = (await this.repo.purgeWorkspaceHistory(workspaceId)).executions;
    await this.repo.appendAudit({ workspaceId, executionId: null, eventType: 'demo.reset', actor, payload: { clearHistory: opts.clearHistory, executionsDeleted: purged } });
    return { resources: this.store.listResources(workspaceId), executionsDeleted: purged };
  }
}
