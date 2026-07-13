import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { healthzReplySchema, readyzReplySchema, type ReadyCheck } from '@authledger/shared';

export interface HealthDeps {
  checkDatabase: () => Promise<void>;
  pendingMigrations: () => Promise<string[]>;
}

export const healthRoutes: FastifyPluginAsyncTypebox<{ deps: HealthDeps }> = async (
  app,
  { deps },
) => {
  app.get(
    '/healthz',
    {
      schema: {
        description: 'Liveness. Checks nothing external so an outage cannot cause a restart loop.',
        response: { 200: healthzReplySchema },
      },
    },
    async () => ({ status: 'ok' as const, uptime_s: Math.round(process.uptime()) }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        description: 'Readiness. Verifies the database is reachable and migrations are applied.',
        response: { 200: readyzReplySchema, 503: readyzReplySchema },
      },
    },
    async (req, reply) => {
      const checks: ReadyCheck[] = [];

      try {
        await deps.checkDatabase();
        checks.push({ name: 'database', ok: true });
      } catch (err) {
        req.log.warn({ err }, 'readiness: database check failed');
        checks.push({ name: 'database', ok: false, detail: 'unreachable' });
      }

      try {
        const pending = await deps.pendingMigrations();
        checks.push(
          pending.length === 0
            ? { name: 'migrations', ok: true }
            : { name: 'migrations', ok: false, detail: `${pending.length} pending` },
        );
      } catch (err) {
        req.log.warn({ err }, 'readiness: migration check failed');
        checks.push({ name: 'migrations', ok: false, detail: 'check failed' });
      }

      const ready = checks.every((c) => c.ok);
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? ('ready' as const) : ('unavailable' as const), checks });
    },
  );
};
