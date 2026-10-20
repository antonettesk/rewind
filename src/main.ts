import { loadConfig } from './config.js';
import { createHttpApp, MCP_PATH } from './http/server.js';
import { createApp } from './services/app.js';
import { runRetention } from './services/retention.js';

const config = loadConfig();
const app = await createApp(config);
const http = createHttpApp(app);

const server = http.listen(config.port, config.host, () => {
  const host = config.host === '::1' ? '[::1]' : config.host;
  app.log.info('server.started', {
    console: `http://${host}:${config.port}/`,
    mcp: `http://${host}:${config.port}${MCP_PATH}`,
    trustUpstreamAuth: config.trustUpstreamAuth,
    db: config.dbPath,
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

// Retention: executions past the window, expired guest workspaces, expired sessions. Hourly and at startup.
const retain = () =>
  runRetention(app)
    .then((r) => (r.executions || r.guestWorkspaces || r.sessions) && app.log.info('retention.applied', r))
    .catch((error: unknown) => app.log.error('retention.failed', { message: error instanceof Error ? error.message : String(error) }));
void retain();
const retention = setInterval(retain, 3_600_000);
retention.unref();

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info('server.stopping', { signal });
  clearInterval(retention);
  server.close(() => {
    app.close();
    app.log.info('server.stopped', {});
    process.exit(0);
  });
  // SSE connections stay open; force-close after a grace period.
  setTimeout(() => {
    server.closeAllConnections();
  }, 3_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
