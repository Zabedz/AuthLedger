import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { recordAudit } from './audit.js';

// The fixed set of authorization actions, mirroring the permissions seeded in
// migration 0006. A route requires one of these; adding an action means a
// migration row and a line here, so the type and the table stay in step.
export const PERMISSION_ACTIONS = [
  'users.read',
  'roles.assign',
  'audit.read',
  'sessions.revoke_any',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const ROLE_NAMES = ['admin', 'auditor'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

// Resolves a user's granted actions from their roles. Called per request so a
// role change takes effect on the next request without reissuing the session.
export async function loadPermissions(
  db: Kysely<DB>,
  userId: string,
): Promise<Set<PermissionAction>> {
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
    .select('role_permissions.action')
    .where('user_roles.user_id', '=', userId)
    .execute();
  return new Set(rows.map((r) => r.action as PermissionAction));
}

export async function rolesForUser(db: Kysely<DB>, userId: string): Promise<RoleName[]> {
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select('roles.name')
    .where('user_roles.user_id', '=', userId)
    .orderBy('roles.name')
    .execute();
  return rows.map((r) => r.name as RoleName);
}

async function roleIdByName(db: Kysely<DB>, role: RoleName): Promise<string> {
  const row = await db.selectFrom('roles').select('id').where('name', '=', role).executeTakeFirst();
  if (!row) {
    throw new Error(`no such role: ${role}`);
  }
  return row.id;
}

// Grants a role. Returns false when the user already held it, so the caller can
// keep the operation idempotent without a second query.
export async function assignRole(
  db: Kysely<DB>,
  userId: string,
  role: RoleName,
  grantedBy: string | null,
): Promise<boolean> {
  const roleId = await roleIdByName(db, role);
  const result = await db
    .insertInto('user_roles')
    .values({ user_id: userId, role_id: roleId, granted_by: grantedBy })
    .onConflict((oc) => oc.columns(['user_id', 'role_id']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
}

export async function revokeRole(db: Kysely<DB>, userId: string, role: RoleName): Promise<boolean> {
  const roleId = await roleIdByName(db, role);
  const result = await db
    .deleteFrom('user_roles')
    .where('user_id', '=', userId)
    .where('role_id', '=', roleId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n) > 0;
}

// True when this user is the only holder of admin, so revoking it would leave
// no one able to grant roles. In-app recovery from a full lockout would then
// need a restart with ADMIN_EMAIL set, so the admin route refuses this.
export async function isLastAdmin(db: Kysely<DB>, userId: string): Promise<boolean> {
  const admins = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select('user_roles.user_id')
    .where('roles.name', '=', 'admin')
    .execute();
  return admins.length === 1 && admins[0]?.user_id === userId;
}

export interface AdminUserRow {
  id: string;
  email: string;
  email_verified: boolean;
  mfa_enabled: boolean;
  roles: RoleName[];
  created_at: string;
}

// A page of accounts with their roles, for the admin user list. Roles come from
// a second query keyed by the page's ids, so the page size bounds both queries.
export async function listUsersWithRoles(
  db: Kysely<DB>,
  limit: number,
  offset: number,
): Promise<AdminUserRow[]> {
  const users = await db
    .selectFrom('users')
    .select(['id', 'email', 'email_verified_at', 'totp_enabled_at', 'created_at'])
    .orderBy('created_at', 'asc')
    .limit(limit)
    .offset(offset)
    .execute();
  if (users.length === 0) {
    return [];
  }

  const grants = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select(['user_roles.user_id', 'roles.name'])
    .where(
      'user_roles.user_id',
      'in',
      users.map((u) => u.id),
    )
    .execute();

  const rolesByUser = new Map<string, RoleName[]>();
  for (const g of grants) {
    const list = rolesByUser.get(g.user_id) ?? [];
    list.push(g.name as RoleName);
    rolesByUser.set(g.user_id, list);
  }

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    email_verified: u.email_verified_at !== null,
    mfa_enabled: u.totp_enabled_at !== null,
    roles: (rolesByUser.get(u.id) ?? []).sort(),
    created_at: u.created_at.toISOString(),
  }));
}

// Idempotent bootstrap: grants admin to the configured operator once that
// account exists. A no-op until they register, so it is safe to run every boot.
export async function ensureAdminRole(db: Kysely<DB>, email: string): Promise<void> {
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (!user) {
    return;
  }
  const granted = await assignRole(db, user.id, 'admin', null);
  if (granted) {
    // The first, most privileged grant should leave a trail like every other.
    await recordAudit(db, {
      event: 'role_granted',
      detail: { target: user.id, role: 'admin', source: 'bootstrap' },
    });
  }
}
