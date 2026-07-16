import Fastify, { type FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerSentryErrorHandler } from '../src/plugins/sentry.js';
import { reportServerError } from '../src/sentry.js';

// Capture events in beforeSend and return null, so nothing is sent anywhere and
// the assertions read exactly what would have shipped.
const captured: Sentry.ErrorEvent[] = [];

beforeAll(() => {
  Sentry.init({
    dsn: 'https://examplekey@o1.ingest.de.sentry.io/1',
    defaultIntegrations: false,
    integrations: [],
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
    beforeSend(event) {
      captured.push(event);
      return null;
    },
  });
});

afterAll(async () => {
  await Sentry.close();
});

beforeEach(() => {
  captured.length = 0;
});

async function makeApp(register: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const app = Fastify();
  registerSentryErrorHandler(app);
  register(app);
  await app.ready();
  return app;
}

function firstMessage(): string | undefined {
  return captured[0]?.exception?.values?.[0]?.value;
}

describe('sentry error reporting', () => {
  it('reports a thrown 500 with the error message', async () => {
    const app = await makeApp((a) =>
      a.get('/boom', async () => {
        throw new Error('kaboom in a handler');
      }),
    );
    expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500);
    await Sentry.flush(1000);
    await app.close();

    expect(captured).toHaveLength(1);
    expect(firstMessage()).toContain('kaboom in a handler');
  });

  it('reports a thrown 5xx that carries an explicit status', async () => {
    const app = await makeApp((a) =>
      a.get('/down', async () => {
        throw Object.assign(new Error('upstream down'), { statusCode: 503 });
      }),
    );
    expect((await app.inject({ method: 'GET', url: '/down' })).statusCode).toBe(503);
    await Sentry.flush(1000);
    await app.close();

    expect(captured).toHaveLength(1);
    expect(firstMessage()).toContain('upstream down');
  });

  it('does not report a 4xx client error', async () => {
    const app = await makeApp((a) =>
      a.get('/bad', async () => {
        throw Object.assign(new Error('bad input'), { statusCode: 400 });
      }),
    );
    expect((await app.inject({ method: 'GET', url: '/bad' })).statusCode).toBe(400);
    await Sentry.flush(1000);
    await app.close();

    expect(captured).toEqual([]);
  });

  it('reports a returned 5xx through reportServerError, which onError never sees', async () => {
    const app = await makeApp((a) =>
      a.get('/upstream', async (req, reply) => {
        try {
          throw new Error('stripe unreachable');
        } catch (err) {
          reportServerError(err, req);
          return reply.code(502).send({ error: 'upstream' });
        }
      }),
    );
    expect((await app.inject({ method: 'GET', url: '/upstream' })).statusCode).toBe(502);
    await Sentry.flush(1000);
    await app.close();

    expect(captured).toHaveLength(1);
    expect(firstMessage()).toContain('stripe unreachable');
  });

  it('attaches the route template, never the raw url with its query', async () => {
    const app = await makeApp((a) =>
      a.get('/boom', async () => {
        throw new Error('with a query string');
      }),
    );
    await app.inject({ method: 'GET', url: '/boom?token=secret' });
    await Sentry.flush(1000);
    await app.close();

    expect(captured).toHaveLength(1);
    const request = captured[0]!.contexts?.request as { url?: string } | undefined;
    expect(request?.url).toBe('/boom');
    expect(String(request?.url)).not.toContain('secret');
  });
});
