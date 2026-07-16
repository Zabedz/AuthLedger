import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export type AuditEvent =
  | 'user_registered'
  | 'login_succeeded'
  | 'login_failed'
  | 'login_rejected_locked'
  | 'account_locked'
  | 'logout'
  | 'session_revoked'
  | 'email_verified'
  | 'password_reset'
  | 'account_deleted'
  | 'email_bounced'
  | 'email_complained'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_challenge_issued'
  | 'mfa_succeeded'
  | 'mfa_failed'
  | 'recovery_code_used'
  | 'oauth_login'
  | 'oauth_account_created'
  | 'role_granted'
  | 'role_revoked'
  | 'admin_sessions_revoked'
  | 'payment_created'
  | 'payment_refunded'
  | 'reconciliation_run'
  | 'authz_denied';

export interface AuditEntry {
  event: AuditEvent;
  userId?: string;
  sessionId?: string;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

// A user agent is a caller-supplied header; enough survives for forensics, a
// header-sized payload does not become row growth.
const USER_AGENT_MAX = 256;

export async function recordAudit(db: Kysely<DB>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      event: entry.event,
      user_id: entry.userId ?? null,
      session_id: entry.sessionId ?? null,
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ? entry.userAgent.slice(0, USER_AGENT_MAX) : null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}

export interface AuditRow {
  id: string;
  event: string;
  user_id: string | null;
  ip: string | null;
  at: string;
  detail: unknown;
}

// The most recent events first, for the admin audit view.
export async function listAuditEvents(db: Kysely<DB>, limit: number): Promise<AuditRow[]> {
  const rows = await db
    .selectFrom('audit_events')
    .select(['id', 'event', 'user_id', 'ip', 'at', 'detail'])
    .orderBy('at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    user_id: r.user_id,
    ip: r.ip,
    at: r.at.toISOString(),
    detail: r.detail,
  }));
}
