import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Config } from './config.js';
import { loggerOptions, requestContext } from './logging.js';
import { registerOpenapi } from './plugins/openapi.js';
import { healthRoutes, type HealthDeps } from './routes/health.js';

export interface ServerDeps {
  health: HealthDeps;
}

export async function buildServer(config: Config, deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config),
    requestIdLogLabel: 'req_id',
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

  await registerOpenapi(app, config);
  await app.register(healthRoutes, { prefix: '/api', deps: deps.health });

  return app;
}
