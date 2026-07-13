import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { HealthDeps } from '../src/routes/health.js';

const config: Config = {
  nodeEnv: 'test',
  port: 0,
  logLevel: 'fatal',
  databaseUrl: 'postgres://unused',
  stripeSecretKey: undefined,
};

const healthyDeps: HealthDeps = {
  checkDatabase: async () => {},
  pendingMigrations: async () => [],
};

let app: FastifyInstance;

async function start(deps: HealthDeps): Promise<FastifyInstance> {
  app = await buildServer(config, { health: deps });
  return app;
}

afterEach(async () => {
  await app?.close();
});

describe('GET /api/healthz', () => {
  it('returns ok without touching dependencies', async () => {
    await start({
      checkDatabase: async () => {
        throw new Error('database is down');
      },
      pendingMigrations: async () => {
        throw new Error('database is down');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('GET /api/readyz', () => {
  it('returns ready when all checks pass', async () => {
    await start(healthyDeps);
    const res = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: [
        { name: 'database', ok: true },
        { name: 'migrations', ok: true },
      ],
    });
  });

  it('returns 503 when the database is unreachable', async () => {
    await start({
      ...healthyDeps,
      checkDatabase: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    expect(res.json().checks).toContainEqual({
      name: 'database',
      ok: false,
      detail: 'unreachable',
    });
  });

  it('returns 503 when migrations are pending', async () => {
    await start({
      ...healthyDeps,
      pendingMigrations: async () => ['0001_users'],
    });
    const res = await app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toContainEqual({
      name: 'migrations',
      ok: false,
      detail: '1 pending',
    });
  });
});

describe('request id', () => {
  it('echoes an inbound x-request-id', async () => {
    await start(healthyDeps);
    const res = await app.inject({
      method: 'GET',
      url: '/api/healthz',
      headers: { 'x-request-id': 'req-from-client' },
    });
    expect(res.headers['x-request-id']).toBe('req-from-client');
  });

  it('generates a request id when none is sent', async () => {
    await start(healthyDeps);
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
