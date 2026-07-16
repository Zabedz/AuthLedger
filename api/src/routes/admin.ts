import { Type } from '@sinclair/typebox';
import {
  adminUserListSchema,
  auditListSchema,
  errorReplySchema,
  ledgerBalancesSchema,
  reconciliationListSchema,
  reconciliationResultSchema,
  roleNameSchema,
  userRolesSchema,
} from '@authledger/shared';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type Stripe from 'stripe';
import { listAuditEvents, recordAudit } from '../domain/audit.js';
import {
  assignRole,
  isLastAdmin,
  listUsersWithRoles,
  revokeRole,
  rolesForUser,
} from '../domain/authz.js';
import { ledgerBalances } from '../domain/ledger.js';
import { runAndRecordReconciliation } from '../domain/reconciliation.js';
import { revokeAllSessions } from '../domain/sessions.js';
import { authorize } from '../plugins/authz-guard.js';
import { requestContextOf, type RouteDeps } from './deps.js';

export interface AdminDeps extends RouteDeps {
  stripe: Stripe;
}

const RECON_PAGE = 50;

const USERS_PAGE = 50;
const AUDIT_PAGE = 100;

const pageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

const userRoleParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  role: roleNameSchema,
});

export const adminRoutes: FastifyPluginAsyncTypebox<AdminDeps> = async (app, { db, stripe }) => {
  app.get(
    '/users',
    {
      ...authorize('users.read'),
      schema: { querystring: pageQuery, response: { 200: adminUserListSchema } },
    },
    async (req) => {
      const users = await listUsersWithRoles(
        db,
        req.query.limit ?? USERS_PAGE,
        req.query.offset ?? 0,
      );
      return { users };
    },
  );

  app.get(
    '/audit',
    {
      ...authorize('audit.read'),
      schema: { querystring: pageQuery, response: { 200: auditListSchema } },
    },
    async (req) => {
      return { events: await listAuditEvents(db, req.query.limit ?? AUDIT_PAGE) };
    },
  );

  app.put(
    '/users/:id/roles/:role',
    {
      ...authorize('roles.assign'),
      schema: { params: userRoleParams, response: { 200: userRolesSchema, 404: errorReplySchema } },
    },
    async (req, reply) => {
      const target = await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!target) {
        return reply.code(404).send({ error: 'no such user' });
      }
      const granted = await assignRole(db, req.params.id, req.params.role, req.auth!.user.id);
      if (granted) {
        await recordAudit(db, {
          event: 'role_granted',
          userId: req.auth!.user.id,
          ...requestContextOf(req),
          detail: { target: req.params.id, role: req.params.role },
        });
      }
      return reply.code(200).send({ roles: await rolesForUser(db, req.params.id) });
    },
  );

  app.delete(
    '/users/:id/roles/:role',
    {
      ...authorize('roles.assign'),
      schema: {
        params: userRoleParams,
        response: { 200: userRolesSchema, 409: errorReplySchema },
      },
    },
    async (req, reply) => {
      // Refuse to strip admin from the only admin, which would lock everyone out
      // of role management until a restart with ADMIN_EMAIL set.
      if (req.params.role === 'admin' && (await isLastAdmin(db, req.params.id))) {
        return reply.code(409).send({ error: 'cannot remove the last admin' });
      }
      const revoked = await revokeRole(db, req.params.id, req.params.role);
      if (revoked) {
        await recordAudit(db, {
          event: 'role_revoked',
          userId: req.auth!.user.id,
          ...requestContextOf(req),
          detail: { target: req.params.id, role: req.params.role },
        });
      }
      return reply.code(200).send({ roles: await rolesForUser(db, req.params.id) });
    },
  );

  app.delete(
    '/users/:id/sessions',
    {
      ...authorize('sessions.revoke_any'),
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ revoked: Type.Integer() }) },
      },
    },
    async (req, reply) => {
      const revoked = await revokeAllSessions(db, req.params.id);
      if (revoked > 0) {
        await recordAudit(db, {
          event: 'admin_sessions_revoked',
          userId: req.auth!.user.id,
          ...requestContextOf(req),
          detail: { target: req.params.id, count: revoked },
        });
      }
      return reply.code(200).send({ revoked });
    },
  );

  // Ledger balances per account and currency.
  app.get(
    '/ledger',
    { ...authorize('ledger.view'), schema: { response: { 200: ledgerBalancesSchema } } },
    async () => ({ balances: await ledgerBalances(db) }),
  );

  // Run reconciliation now (the scheduled job runs the same logic). Posts fees
  // from the provider's balance transactions and reports any discrepancy.
  app.post(
    '/reconcile',
    { ...authorize('ledger.reconcile'), schema: { response: { 200: reconciliationResultSchema } } },
    async (req, reply) => {
      const result = await runAndRecordReconciliation(db, stripe);
      await recordAudit(db, {
        event: 'reconciliation_run',
        userId: req.auth!.user.id,
        ...requestContextOf(req),
        detail: { checked: result.checked, discrepancy_count: result.discrepancies.length },
      });
      return reply.code(200).send({
        id: result.id,
        checked: result.checked,
        fees_posted_minor: result.feesPostedMinor,
        discrepancy_count: result.discrepancies.length,
        discrepancies: result.discrepancies.map((d) => ({
          reference: d.reference,
          amount_minor: d.amountMinor,
          reason: d.reason,
        })),
      });
    },
  );

  app.get(
    '/reconciliations',
    { ...authorize('ledger.view'), schema: { response: { 200: reconciliationListSchema } } },
    async () => {
      const rows = await db
        .selectFrom('reconciliations')
        .select([
          'id',
          'ran_at',
          'status',
          'error',
          'checked',
          'fees_posted_minor',
          'discrepancy_count',
        ])
        .orderBy('ran_at', 'desc')
        .limit(RECON_PAGE)
        .execute();
      return {
        reconciliations: rows.map((r) => ({
          id: r.id,
          ran_at: r.ran_at.toISOString(),
          status: r.status === 'failed' ? ('failed' as const) : ('ok' as const),
          error: r.error,
          checked: r.checked,
          fees_posted_minor: Number(r.fees_posted_minor),
          discrepancy_count: r.discrepancy_count,
        })),
      };
    },
  );
};
