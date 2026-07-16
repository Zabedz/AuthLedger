import type { FastifyContextConfig, FastifyInstance, RouteOptions } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { PermissionAction } from '../domain/authz.js';
import { recordAudit } from '../domain/audit.js';
import { requirePermission } from './session-auth.js';

// How a route is protected. 'public' needs no session; 'self' needs a session
// and touches only the caller's own resources; { permission } needs that
// permission. Every /api route declares one, so an endpoint added without a
// deliberate choice fails the boot check below rather than defaulting to open.
export type RoutePolicy = 'public' | 'self' | { permission: PermissionAction };

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
}

// Bundles the request-time enforcement and the declared policy for a permission
// so a route names the action once and the two cannot drift apart. Spread into
// the route options: app.get(url, { ...authorize('users.read'), schema }, ...).
export function authorize(
  action: PermissionAction,
  opts: { rateLimit?: FastifyContextConfig['rateLimit'] } = {},
): {
  preHandler: ReturnType<typeof requirePermission>;
  config: FastifyContextConfig;
} {
  return {
    preHandler: requirePermission(action),
    config: {
      policy: { permission: action },
      ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    },
  };
}

// The dev-only docs UI and raw spec describe themselves and carry no policy.
function isExempt(url: string): boolean {
  return url === '/api/openapi.json' || url === '/api/docs' || url.startsWith('/api/docs/');
}

// A user producing more denials than this per minute is a scanner, not a UI
// gap; the flood is summarized in one row instead of written row by row, so a
// prober cannot grow the table without bound or bury real events behind its
// own noise.
const DENIALS_AUDITED_PER_MINUTE = 10;
// The suppression map cannot grow past this many distinct denied users; the
// reset just re-audits a few rows, so correctness does not depend on it.
const DENIAL_COUNTER_CEILING = 10_000;

// Every authenticated 403 lands in the audit log: a denial is a security
// signal (probing, a UI gap, a mis-granted role), and the route template plus
// method is enough to see the pattern without recording request content. 401s
// stay out, since an anonymous scan would write unattributable rows; routes
// authenticated by signature carry no session, so their 403s stay out too.
export function registerDenialAudit(app: FastifyInstance, db: Kysely<DB>): void {
  const counters = new Map<string, { windowStart: number; count: number }>();

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode !== 403 || !req.auth) {
      return;
    }

    const now = Date.now();
    const userId = req.auth.user.id;
    const window = counters.get(userId);
    let suppressedTrip = false;
    if (!window || now - window.windowStart >= 60_000) {
      if (counters.size >= DENIAL_COUNTER_CEILING) {
        counters.clear();
      }
      counters.set(userId, { windowStart: now, count: 1 });
    } else {
      window.count += 1;
      if (window.count > DENIALS_AUDITED_PER_MINUTE + 1) {
        return;
      }
      suppressedTrip = window.count === DENIALS_AUDITED_PER_MINUTE + 1;
    }

    await recordAudit(db, {
      event: 'authz_denied',
      userId,
      sessionId: req.auth.session.id,
      ip: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      detail: suppressedTrip
        ? { method: req.method, route: req.routeOptions.url ?? 'unmatched', suppressed: true }
        : { method: req.method, route: req.routeOptions.url ?? 'unmatched' },
    });
  });
}

// Collects every registered /api route and, once the tree is built, refuses to
// start if any lacks a policy. Register before the routes so onRoute sees them.
export function registerAuthzGuard(app: FastifyInstance): void {
  const unguarded: string[] = [];

  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.url.startsWith('/api') || isExempt(route.url)) {
      return;
    }
    if (!route.config?.policy) {
      unguarded.push(`${String(route.method)} ${route.url}`);
    }
  });

  app.addHook('onReady', async () => {
    if (unguarded.length > 0) {
      throw new Error(
        `deny-by-default: these /api routes declare no authorization policy: ${unguarded.join(', ')}`,
      );
    }
  });
}
