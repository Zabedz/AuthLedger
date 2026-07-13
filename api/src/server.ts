import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import type { DB } from './db/types.js';
import { loggerOptions, requestContext } from './logging.js';
import { registerOpenapi } from './plugins/openapi.js';
import { registerOriginCheck } from './plugins/origin-check.js';
import { registerSessionAuth } from './plugins/session-auth.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type HealthDeps } from './routes/health.js';

export interface ServerDeps {
  health: HealthDeps;
  db: Kysely<DB>;
}

export interface ServerOptions {
  // Tests capture log output through here to prove redaction.
  loggerStream?: NodeJS.WritableStream;
}

export async function buildServer(
  config: Config,
  deps: ServerDeps,
  opts: ServerOptions = {},
): Promise<FastifyInstance> {
  const baseLogger = loggerOptions(config);
  const app = Fastify({
    logger:
      opts.loggerStream && typeof baseLogger === 'object'
        ? { ...baseLogger, stream: opts.loggerStream }
        : baseLogger,
    logController: new LogController({ requestIdLogLabel: 'req_id' }),
    // Behind the ALB the client address arrives in x-forwarded-for.
    trustProxy: config.nodeEnv === 'production',
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && /^[\w.-]{1,128}$/.test(inbound)
        ? inbound
        : randomUUID();
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onRequest', (req, _reply, done) => {
    requestContext.run({ requestId: req.id }, done);
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerOriginCheck(app, config);
  await app.register(rateLimit, { global: false });
  await registerSessionAuth(app, config, deps.db);
  await registerOpenapi(app, config);

  await app.register(healthRoutes, { prefix: '/api', deps: deps.health });
  await app.register(authRoutes, { prefix: '/api/auth', config, db: deps.db });

  return app;
}
