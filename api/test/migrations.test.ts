import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { pendingMigrations } from '../src/db/migrations.js';

function poolWithApplied(names: string[]): pg.Pool {
  return {
    query: async () => ({ rows: names.map((name) => ({ name })) }),
  } as unknown as pg.Pool;
}

function poolWithoutTable(): pg.Pool {
  return {
    query: async () => {
      throw Object.assign(new Error('relation "pgmigrations" does not exist'), {
        code: '42P01',
      });
    },
  } as unknown as pg.Pool;
}

async function migrationsDir(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'authledger-migrations-'));
  for (const f of files) {
    await writeFile(path.join(dir, f), 'SELECT 1;');
  }
  return dir;
}

describe('pendingMigrations', () => {
  it('returns nothing for an empty directory without querying', async () => {
    const dir = await migrationsDir([]);
    const pool = {
      query: async () => {
        throw new Error('must not query when no files exist');
      },
    } as unknown as pg.Pool;
    expect(await pendingMigrations(pool, dir)).toEqual([]);
  });

  it('reports files that have no applied row', async () => {
    const dir = await migrationsDir(['0001_users.sql', '0002_sessions.sql']);
    const pool = poolWithApplied(['0001_users']);
    expect(await pendingMigrations(pool, dir)).toEqual(['0002_sessions']);
  });

  it('treats a missing bookkeeping table as nothing applied', async () => {
    const dir = await migrationsDir(['0001_users.sql']);
    expect(await pendingMigrations(poolWithoutTable(), dir)).toEqual(['0001_users']);
  });

  it('ignores non-sql files', async () => {
    const dir = await migrationsDir(['.gitkeep', 'notes.txt', '0001_users.sql']);
    const pool = poolWithApplied([]);
    expect(await pendingMigrations(pool, dir)).toEqual(['0001_users']);
  });

  it('throws when the directory is missing (broken artifact, not zero migrations)', async () => {
    const pool = poolWithApplied([]);
    await expect(pendingMigrations(pool, '/nonexistent/migrations')).rejects.toThrow();
  });
});
