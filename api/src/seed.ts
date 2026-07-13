import { loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { hashPassword } from './domain/passwords.js';

// Fixed identity so manual testing and docs reference the same record across
// re-seeds. Roles arrive in M5; this stays one known user until then.
const DEMO_USER = {
  id: '00000000-0000-7000-8000-000000000001',
  email: 'demo@authledger.test',
  password: 'demo-password-change-me',
};

async function seed(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  try {
    const passwordHash = await hashPassword(DEMO_USER.password);
    const result = await db
      .insertInto('users')
      .values({ id: DEMO_USER.id, email: DEMO_USER.email, password_hash: passwordHash })
      .onConflict((oc) => oc.column('email').doNothing())
      .executeTakeFirst();

    const created = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    process.stdout.write(
      `${created ? 'created' : 'already present'}: ${DEMO_USER.email} (${DEMO_USER.id})\n`,
    );
  } finally {
    await db.destroy();
  }
}

await seed();
