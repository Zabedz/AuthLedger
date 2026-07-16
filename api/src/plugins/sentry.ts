import type { FastifyInstance } from 'fastify';
import { reportServerError } from '../sentry.js';

// Reports the thrown server failures Fastify surfaces. A thrown error carries
// its intended status (Fastify sets it on validation and http errors), but the
// reply status is not set yet when onError runs, so filter on the error itself:
// no status means an unexpected 500, a 4xx is a client error and skipped. A
// returned 5xx (a caught error turned into reply.code(5xx)) does not fire
// onError; those call reportServerError at the catch site. Register only after
// startSentry has initialized the client.
export function registerSentryErrorHandler(app: FastifyInstance): void {
  app.addHook('onError', async (request, _reply, error) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      reportServerError(error, request);
    }
  });
}
