import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    // Set on routes that authenticate by signature (provider webhooks) so the
    // cookie-oriented CSRF gate does not apply.
    skipOriginCheck?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defense for cookie auth (with SameSite=Lax as the baseline): every
// state-changing request must carry the app's own Origin. The API emits no
// CORS headers, so this is the whole cross-origin policy. Routes that
// authenticate by signature instead of cookies (provider webhooks) opt out
// with config.skipOriginCheck.
export function registerOriginCheck(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) {
      return;
    }
    if (req.routeOptions.config.skipOriginCheck === true) {
      return;
    }
    if (req.headers.origin !== config.appOrigin) {
      req.log.warn({ origin: req.headers.origin ?? null }, 'rejected cross-origin request');
      return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
  });
}
