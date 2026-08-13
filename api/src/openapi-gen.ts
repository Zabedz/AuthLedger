import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { buildServer } from './server.js';

// Writes docs/openapi.json from the live route schemas. The schemas validate
// every request and reply; the OpenAPI document is their byproduct (see
// plugins/openapi.ts). Capturing it as a committed artifact, and checking it
// for drift in CI, is the same discipline the generated query types follow.
//
// A fixed dev config makes the output depend only on the code. buildServer
// registers routes and hooks but issues no query at ready(), so the pool is
// never connected.
const config = loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://openapi-gen' });
const pool = createPool(config.databaseUrl);
const db = createDb(pool);

const app = await buildServer(config, {
  db,
  enqueue: { enqueue: async () => {} },
  health: { checkDatabase: async () => {}, pendingMigrations: async () => [] },
});

await app.ready();
const spec = app.swagger();
const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/openapi.json');
await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n');
await app.close();
await pool.end();
process.stdout.write(`wrote ${outPath}\n`);
