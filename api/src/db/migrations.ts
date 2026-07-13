import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const MIGRATIONS_TABLE_MISSING = '42P01';

// node-pg-migrate records applied migrations in pgmigrations by filename
// without extension. Pending = files on disk that have no row there.
export async function pendingMigrations(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  // A missing directory means a broken artifact, not zero migrations; let it throw.
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
  if (files.length === 0) {
    return [];
  }

  let appliedRows: { name: string }[];
  try {
    const result = await pool.query<{ name: string }>('SELECT name FROM pgmigrations');
    appliedRows = result.rows;
  } catch (err) {
    if ((err as { code?: string }).code === MIGRATIONS_TABLE_MISSING) {
      appliedRows = [];
    } else {
      throw err;
    }
  }

  const applied = new Set(appliedRows.map((r) => r.name));
  return files.map((f) => path.basename(f, '.sql')).filter((name) => !applied.has(name));
}
