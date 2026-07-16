import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from '../config.js';

// Route schemas exist for validation; the OpenAPI document is their byproduct.
// The spec and its UI are exposed in development only.
export async function registerOpenapi(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AuthLedger API',
        description: 'Identity and payments: hand-built auth/authz and a double-entry ledger.',
        version: '0.0.0',
      },
    },
  });

  if (config.nodeEnv === 'development') {
    await app.register(swaggerUi, { routePrefix: '/api/docs' });
    app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }
}
