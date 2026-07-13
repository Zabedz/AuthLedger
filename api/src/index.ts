import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { pendingMigrations } from './db/migrations.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDb(pool);

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

const app = await buildServer(config, {
  db,
  health: {
    checkDatabase: async () => {
      await pool.query('SELECT 1');
    },
    pendingMigrations: () => pendingMigrations(pool, migrationsDir),
  },
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
