/**
 * Database utilities.
 *   npm run db:migrate   apply pending migrations (also happens on server start)
 *   npm run db:reset     delete the local database file and recreate it from migrations + seed
 */
import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { migrate, openDatabase } from '../src/persistence/db.js';
import { createApp } from '../src/services/app.js';

const cmd = process.argv[2];
const config = loadConfig();

if (cmd === 'migrate') {
  const db = openDatabase(config.dbPath);
  const ran = migrate(db);
  const all = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  db.close();
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date.');
  console.table(all);
} else if (cmd === 'reset') {
  if (config.dbPath === ':memory:') throw new Error('Nothing to reset for an in-memory database.');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(config.dbPath + suffix)) rmSync(config.dbPath + suffix);
  const app = await createApp(config, { logger: createLogger('warn') });
  app.close();
  console.log(`Recreated ${config.dbPath} with the deterministic demo seed and default policies.`);
} else {
  console.error('Usage: tsx scripts/db.ts <migrate|reset>');
  process.exit(1);
}
