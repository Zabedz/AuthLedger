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
  | 'email_complained';

export interface AuditEntry {
  event: AuditEvent;
  userId?: string;
  sessionId?: string;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordAudit(db: Kysely<DB>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      event: entry.event,
      user_id: entry.userId ?? null,
      session_id: entry.sessionId ?? null,
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
