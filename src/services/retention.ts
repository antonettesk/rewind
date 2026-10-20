import type { App } from './app.js';

/**
 * Retention, run hourly by the server:
 *  - finished executions older than REWIND_RETENTION_DAYS are deleted in every workspace;
 *  - guest workspaces older than REWIND_GUEST_RETENTION_HOURS are deleted entirely;
 *  - expired sessions are removed.
 */
export async function runRetention(app: App, now = Date.now()) {
  const cutoff = new Date(now - app.config.retentionDays * 86_400_000).toISOString();
  let executions = 0;
  for (const ws of await app.repo.listWorkspaceIds()) executions += (await app.repo.purgeOlderThan(ws, cutoff)).executions;

  const guestCutoff = new Date(now - app.config.guestRetentionHours * 3_600_000).toISOString();
  const guests = await app.accounts.guestWorkspacesOlderThan(guestCutoff);
  for (const ws of guests) {
    await app.repo.purgeWorkspaceHistory(ws);
    await app.accounts.deleteWorkspaceIdentity(ws);
  }
  const sessions = await app.accounts.deleteExpiredSessions();
  return { executions, guestWorkspaces: guests.length, sessions };
}
