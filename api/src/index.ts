import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { pendingMigrations } from './db/migrations.js';
import { ensureAdminRole } from './domain/authz.js';
import { createSmtpMailer } from './domain/mailer.js';
import { createJobRunner } from './jobs/queue.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDb(pool);
const mailer = createSmtpMailer(config.smtp, config.nodeEnv === 'production');

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

const app = await buildServer(config, {
  db,
  enqueue: { enqueue: (request) => jobs.enqueue(request) },
  health: {
    checkDatabase: async () => {
      await pool.query('SELECT 1');
    },
    pendingMigrations: () => pendingMigrations(pool, migrationsDir),
  },
});

// Started before listen so no request is served before the queue accepts work.
const jobs = createJobRunner(config.databaseUrl, db, mailer, app.log);
await jobs.start();

// Grant the configured operator the admin role, so a fresh deploy has a way in.
if (config.adminEmail) {
  await ensureAdminRole(db, config.adminEmail);
}

const SHUTDOWN_DEADLINE_MS = 15_000;

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Bound the graceful shutdown so a hung close cannot outlast the
    // orchestrator's stop grace and get SIGKILLed mid-write.
    const deadline = setTimeout(() => {
      app.log.error('shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    void app
      .close()
      .then(() => jobs.stop())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
