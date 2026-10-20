/**
 * Persistent backing store for the home-sim adapter. Every workspace gets its
 * own synthetic home. Every read and write goes to SQLite, so the demo's state
 * survives restarts and recovery is checked against what is actually stored.
 */
import type { ResourceState } from '../types.js';
import { transaction, type Db } from '../../persistence/db.js';
import { newId, nowIso } from '../../domain/util.js';
import { AdapterError } from '../../domain/errors.js';

export const FAULT_MODES = ['error', 'transient', 'timeout', 'compensation_error', 'drift', 'silent_compensation_failure'] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface Fault {
  id: string;
  operation: string;
  mode: FaultMode;
  remaining: number;
  createdAt: string;
}

/** The deterministic seed. Reset always returns a workspace's home to exactly this. */
export const SEED_STATE: Record<string, Record<string, Record<string, unknown>>> = {
  thermostat: { main: { mode: 'home', targetC: 21 } },
  tasks: {
    household: {
      items: [
        { id: 't1', title: 'Water the plants', done: false },
        { id: 't2', title: 'Take out recycling', done: false },
      ],
    },
  },
  security: { routine: { routine: 'weekend-away', state: 'inactive' } },
  notifications: { outbox: { sent: [] } },
};

export class HomeSimStore {
  constructor(private readonly db: Db) {}

  /** Insert seed rows that are missing for this workspace; existing state is left untouched. */
  ensureSeeded(ws: string): void {
    const t = nowIso();
    for (const [type, byId] of Object.entries(SEED_STATE)) {
      for (const [id, data] of Object.entries(byId)) {
        this.db
          .prepare("INSERT OR IGNORE INTO sim_resources (workspace_id, resource_type, resource_id, version, state_json, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, 'seed')")
          .run(ws, type, id, JSON.stringify(data), t);
      }
    }
  }

  reset(ws: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM sim_resources WHERE workspace_id = ?').run(ws);
      this.db.prepare('DELETE FROM sim_faults WHERE workspace_id = ?').run(ws);
      this.ensureSeeded(ws);
    });
  }

  /** Number of seeded workspace homes; a real query used by the health check. */
  ping(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM sim_resources').get() as { n: number }).n;
  }

  read(ws: string, type: string, id: string): ResourceState {
    const r = this.db.prepare('SELECT * FROM sim_resources WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?').get(ws, type, id) as Record<string, any> | undefined;
    if (!r) throw new AdapterError('RESOURCE_NOT_FOUND', `No ${type} resource "${id}" in this workspace.`, 'none');
    return { version: r.version, data: JSON.parse(r.state_json), meta: { updatedAt: r.updated_at, updatedBy: r.updated_by } };
  }

  /**
   * Compare-and-set write: succeeds only if the stored version still equals
   * `expectedVersion`. This is the optimistic concurrency check compensation
   * relies on to avoid overwriting someone else's change.
   */
  write(ws: string, type: string, id: string, expectedVersion: number, data: Record<string, unknown>, by: string): ResourceState {
    const res = this.db
      .prepare('UPDATE sim_resources SET state_json = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE workspace_id = ? AND resource_type = ? AND resource_id = ? AND version = ?')
      .run(JSON.stringify(data), nowIso(), by, ws, type, id, expectedVersion);
    if (res.changes !== 1) {
      const current = this.read(ws, type, id);
      throw new AdapterError('STATE_CONFLICT', `${type}/${id} is at version ${current.version}, expected ${expectedVersion}.`, 'none');
    }
    return this.read(ws, type, id);
  }

  listResources(ws: string): { type: string; id: string; state: ResourceState }[] {
    const rows = this.db.prepare('SELECT resource_type, resource_id FROM sim_resources WHERE workspace_id = ? ORDER BY resource_type, resource_id').all(ws) as Record<string, string>[];
    return rows.map((r) => ({ type: r.resource_type!, id: r.resource_id!, state: this.read(ws, r.resource_type!, r.resource_id!) }));
  }

  armFault(ws: string, operation: string, mode: FaultMode, count = 1): Fault {
    const f: Fault = { id: newId('evt').replace('evt_', 'flt_'), operation, mode, remaining: count, createdAt: nowIso() };
    this.db.prepare('INSERT INTO sim_faults (id, workspace_id, operation, mode, remaining, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, ws, f.operation, f.mode, f.remaining, f.createdAt);
    return f;
  }

  listFaults(ws: string): Fault[] {
    return (this.db.prepare('SELECT * FROM sim_faults WHERE workspace_id = ? AND remaining > 0 ORDER BY created_at').all(ws) as Record<string, any>[]).map((r) => ({
      id: r.id,
      operation: r.operation,
      mode: r.mode,
      remaining: r.remaining,
      createdAt: r.created_at,
    }));
  }

  clearFaults(ws: string): void {
    this.db.prepare('DELETE FROM sim_faults WHERE workspace_id = ?').run(ws);
  }

  /** Atomically consume one armed fault for this workspace and operation, if any. */
  takeFault(ws: string, operation: string, modes: readonly FaultMode[]): FaultMode | null {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(`SELECT id, mode FROM sim_faults WHERE workspace_id = ? AND operation = ? AND remaining > 0 AND mode IN (${modes.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`)
        .get(ws, operation, ...modes) as { id: string; mode: FaultMode } | undefined;
      if (!r) return null;
      this.db.prepare('UPDATE sim_faults SET remaining = remaining - 1 WHERE id = ?').run(r.id);
      return r.mode;
    });
  }
}
