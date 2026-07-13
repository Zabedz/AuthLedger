import Fastify, { type InjectOptions } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';
import {
  assignRole,
  ensureAdminRole,
  loadPermissions,
  PERMISSION_ACTIONS,
  revokeRole,
  ROLE_NAMES,
  rolesForUser,
} from '../src/domain/authz.js';
import { registerAuthzGuard } from '../src/plugins/authz-guard.js';

const PASSWORD = 'correct-horse-battery';

let ctx: TestContext;

beforeEach(async () => {
  if (ctx) await ctx.close();
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

function inject(method: InjectOptions['method'], url: string, cookie?: string, payload?: object) {
  return ctx.app.inject(withOrigin({ method, url, headers: cookie ? { cookie } : {}, payload }));
}

async function makeUser(email: string): Promise<{ cookie: string; id: string }> {
  await inject('POST', '/api/auth/register', undefined, { email, password: PASSWORD });
  const login = await inject('POST', '/api/auth/login', undefined, { email, password: PASSWORD });
  const row = await ctx.db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  return { cookie: cookieOf(login), id: row.id };
}

// The admin routes and the permission each one requires, so the matrix tests can
// drive every cell without repeating the URLs.
const ROUTES = {
  usersRead: { method: 'GET', url: '/api/admin/users' },
  auditRead: { method: 'GET', url: '/api/admin/audit' },
} as const;

describe('permission matrix', () => {
  it('every admin route is 401 without a session', async () => {
    for (const r of Object.values(ROUTES)) {
      const res = await inject(r.method, r.url);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    const target = await makeUser('target@example.com');
    expect((await inject('PUT', `/api/admin/users/${target.id}/roles/admin`)).statusCode).toBe(401);
    expect((await inject('DELETE', `/api/admin/users/${target.id}/sessions`)).statusCode).toBe(401);
  });

  it('a user with no role is forbidden from every admin route', async () => {
    const { cookie } = await makeUser('plain@example.com');
    const target = await makeUser('target@example.com');
    expect((await inject('GET', '/api/admin/users', cookie)).statusCode).toBe(403);
    expect((await inject('GET', '/api/admin/audit', cookie)).statusCode).toBe(403);
    expect(
      (await inject('PUT', `/api/admin/users/${target.id}/roles/admin`, cookie)).statusCode,
    ).toBe(403);
    expect(
      (await inject('DELETE', `/api/admin/users/${target.id}/sessions`, cookie)).statusCode,
    ).toBe(403);
  });

  it('an admin may use every admin route', async () => {
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const target = await makeUser('target@example.com');

    expect((await inject('GET', '/api/admin/users', admin.cookie)).statusCode).toBe(200);
    expect((await inject('GET', '/api/admin/audit', admin.cookie)).statusCode).toBe(200);

    const grant = await inject('PUT', `/api/admin/users/${target.id}/roles/auditor`, admin.cookie);
    expect(grant.statusCode).toBe(200);
    expect(grant.json().roles).toContain('auditor');

    const revoke = await inject(
      'DELETE',
      `/api/admin/users/${target.id}/roles/auditor`,
      admin.cookie,
    );
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().roles).toEqual([]);

    const kill = await inject('DELETE', `/api/admin/users/${target.id}/sessions`, admin.cookie);
    expect(kill.statusCode).toBe(200);
    expect(kill.json().revoked).toBeGreaterThanOrEqual(1);
  });

  it('an auditor may read but not write', async () => {
    const auditor = await makeUser('auditor@example.com');
    await assignRole(ctx.db, auditor.id, 'auditor', null);
    const target = await makeUser('target@example.com');

    expect((await inject('GET', '/api/admin/users', auditor.cookie)).statusCode).toBe(200);
    expect((await inject('GET', '/api/admin/audit', auditor.cookie)).statusCode).toBe(200);
    expect(
      (await inject('PUT', `/api/admin/users/${target.id}/roles/admin`, auditor.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await inject('DELETE', `/api/admin/users/${target.id}/sessions`, auditor.cookie)).statusCode,
    ).toBe(403);
  });
});

describe('role changes take effect on the next request', () => {
  it('a grant is live without reissuing the session', async () => {
    const user = await makeUser('promotable@example.com');
    expect((await inject('GET', '/api/admin/users', user.cookie)).statusCode).toBe(403);

    await assignRole(ctx.db, user.id, 'admin', null);
    // Same cookie, no new login.
    expect((await inject('GET', '/api/admin/users', user.cookie)).statusCode).toBe(200);
  });
});

describe('/me exposes the caller permissions', () => {
  it('lists the granted actions for UI gating, empty for a plain user', async () => {
    const admin = await makeUser('me-admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const me = await inject('GET', '/api/auth/me', admin.cookie);
    expect(me.json().permissions).toEqual(expect.arrayContaining(['users.read', 'roles.assign']));

    const plain = await makeUser('me-plain@example.com');
    expect((await inject('GET', '/api/auth/me', plain.cookie)).json().permissions).toEqual([]);
  });
});

describe('the seeded tables match the code', () => {
  it('permissions and roles equal the PERMISSION_ACTIONS and ROLE_NAMES literals', async () => {
    const perms = (await ctx.db.selectFrom('permissions').select('action').execute())
      .map((r) => r.action)
      .sort();
    expect(perms).toEqual([...PERMISSION_ACTIONS].sort());
    const roles = (await ctx.db.selectFrom('roles').select('name').execute())
      .map((r) => r.name)
      .sort();
    expect(roles).toEqual([...ROLE_NAMES].sort());
  });
});

describe("a self route cannot reach another user's resource", () => {
  it("revoking another user's session is a 404, not a cross-user delete", async () => {
    const a = await makeUser('a@example.com');
    const b = await makeUser('b@example.com');
    const bSession = await ctx.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', b.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();

    const res = await inject('DELETE', `/api/auth/sessions/${bSession.id}`, a.cookie);
    expect(res.statusCode).toBe(404);
    const still = await ctx.db
      .selectFrom('sessions')
      .select('revoked_at')
      .where('id', '=', bSession.id)
      .executeTakeFirstOrThrow();
    expect(still.revoked_at).toBeNull();
  });
});

describe('the last admin cannot be demoted', () => {
  it('refuses to revoke admin from the only admin, but allows it when another exists', async () => {
    const first = await makeUser('first-admin@example.com');
    await assignRole(ctx.db, first.id, 'admin', null);

    const soloRevoke = await inject(
      'DELETE',
      `/api/admin/users/${first.id}/roles/admin`,
      first.cookie,
    );
    expect(soloRevoke.statusCode).toBe(409);
    expect(await rolesForUser(ctx.db, first.id)).toEqual(['admin']);

    // With a second admin, demoting the first is allowed.
    const second = await makeUser('second-admin@example.com');
    await assignRole(ctx.db, second.id, 'admin', null);
    const revoke = await inject(
      'DELETE',
      `/api/admin/users/${first.id}/roles/admin`,
      second.cookie,
    );
    expect(revoke.statusCode).toBe(200);
    expect(await rolesForUser(ctx.db, first.id)).toEqual([]);
  });
});

describe('role resolution and management', () => {
  it('loadPermissions reflects the seeded matrix', async () => {
    const admin = await makeUser('a@example.com');
    const auditor = await makeUser('b@example.com');
    const plain = await makeUser('c@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    await assignRole(ctx.db, auditor.id, 'auditor', null);

    expect([...(await loadPermissions(ctx.db, admin.id))].sort()).toEqual([
      'audit.read',
      'roles.assign',
      'sessions.revoke_any',
      'users.read',
    ]);
    expect([...(await loadPermissions(ctx.db, auditor.id))].sort()).toEqual([
      'audit.read',
      'users.read',
    ]);
    expect([...(await loadPermissions(ctx.db, plain.id))]).toEqual([]);
  });

  it('assign and revoke are idempotent', async () => {
    const { id } = await makeUser('d@example.com');
    expect(await assignRole(ctx.db, id, 'admin', null)).toBe(true);
    expect(await assignRole(ctx.db, id, 'admin', null)).toBe(false);
    expect(await rolesForUser(ctx.db, id)).toEqual(['admin']);
    expect(await revokeRole(ctx.db, id, 'admin')).toBe(true);
    expect(await revokeRole(ctx.db, id, 'admin')).toBe(false);
    expect(await rolesForUser(ctx.db, id)).toEqual([]);
  });

  it('ensureAdminRole grants once, audits it, and no-ops for a missing account', async () => {
    await ensureAdminRole(ctx.db, 'ghost@example.com'); // no such user yet
    const { id } = await makeUser('operator@example.com');
    await ensureAdminRole(ctx.db, 'operator@example.com');
    await ensureAdminRole(ctx.db, 'operator@example.com');
    expect(await rolesForUser(ctx.db, id)).toEqual(['admin']);

    // The bootstrap grant leaves exactly one audit trail, not one per boot.
    const grants = await ctx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('event', '=', 'role_granted')
      .execute();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.user_id).toBeNull();
  });

  it('grants and revocations are audited', async () => {
    const admin = await makeUser('admin@example.com');
    await assignRole(ctx.db, admin.id, 'admin', null);
    const target = await makeUser('target@example.com');

    await inject('PUT', `/api/admin/users/${target.id}/roles/auditor`, admin.cookie);
    await inject('DELETE', `/api/admin/users/${target.id}/roles/auditor`, admin.cookie);
    await inject('DELETE', `/api/admin/users/${target.id}/sessions`, admin.cookie);

    const events = (await ctx.db.selectFrom('audit_events').select('event').execute()).map(
      (r) => r.event,
    );
    expect(events).toContain('role_granted');
    expect(events).toContain('role_revoked');
    expect(events).toContain('admin_sessions_revoked');
  });
});

describe('deny-by-default boot check', () => {
  it('refuses to start when an /api route declares no policy', async () => {
    const app = Fastify();
    registerAuthzGuard(app);
    app.get('/api/unguarded', async () => 'ok');
    await expect(app.ready()).rejects.toThrow(/deny-by-default/);
    await app.close();
  });

  it('starts when the route declares a policy', async () => {
    const app = Fastify();
    registerAuthzGuard(app);
    app.get('/api/guarded', { config: { policy: 'public' } }, async () => 'ok');
    await expect(app.ready()).resolves.toBeTruthy();
    await app.close();
  });

  it('catches a policy-less route registered inside a plugin (the real path)', async () => {
    const app = Fastify();
    registerAuthzGuard(app);
    await app.register(async (child) => {
      child.get('/api/nested', async () => 'ok');
    });
    await expect(app.ready()).rejects.toThrow(/deny-by-default/);
    await app.close();
  });
});
