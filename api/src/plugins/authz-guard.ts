import type { FastifyInstance, RouteOptions } from 'fastify';
import type { PermissionAction } from '../domain/authz.js';
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
export function authorize(action: PermissionAction): {
  preHandler: ReturnType<typeof requirePermission>;
  config: { policy: RoutePolicy };
} {
  return { preHandler: requirePermission(action), config: { policy: { permission: action } } };
}

// The dev-only docs UI and raw spec describe themselves and carry no policy.
function isExempt(url: string): boolean {
  return url === '/api/openapi.json' || url === '/api/docs' || url.startsWith('/api/docs/');
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
