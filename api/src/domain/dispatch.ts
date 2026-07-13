import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { composeEmail, type EmailContext, type EmailKind } from './emails.js';
import type { EmailMessage, Mailer } from './mailer.js';
import { isSuppressed } from './suppression.js';

export const DAILY_EMAIL_CAP = 20;

// What a route asks for; the transport, dedupe key, and rendered content are
// added when the job is built.
export interface EmailRequest {
  kind: EmailKind;
  recipient: string;
  userId: string | null;
  ctx: EmailContext;
}

// The persisted job payload. The dedupe key is stable across retries of the
// same job but unique per enqueue, so a resent link is a new email while a
// retried delivery is not.
export interface DeliveryJob {
  dedupeKey: string;
  kind: EmailKind;
  recipient: string;
  userId: string | null;
  message: EmailMessage;
}

export interface EmailEnqueuer {
  enqueue(request: EmailRequest): Promise<void>;
}

export function toDeliveryJob(request: EmailRequest): DeliveryJob {
  return {
    dedupeKey: randomUUID(),
    kind: request.kind,
    recipient: request.recipient,
    userId: request.userId,
    message: composeEmail(request.kind, request.recipient, request.ctx),
  };
}

export type DeliveryOutcome =
  'sent' | 'skipped_duplicate' | 'skipped_capped' | 'skipped_suppressed';

function startOfUtcDay(): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export async function deliverEmail(
  db: Kysely<DB>,
  mailer: Mailer,
  job: DeliveryJob,
): Promise<DeliveryOutcome> {
  // Never send to an address SES flagged as a bounce or complaint.
  if (await isSuppressed(db, job.recipient)) {
    return 'skipped_suppressed';
  }

  const claim = await db
    .insertInto('email_dispatches')
    .values({
      user_id: job.userId,
      recipient: job.recipient,
      kind: job.kind,
      dedupe_key: job.dedupeKey,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  let dispatchId: string;

  if (claim) {
    dispatchId = claim.id;
    if (job.userId) {
      const { count } = await db
        .selectFrom('email_dispatches')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', job.userId)
        .where('created_at', '>=', startOfUtcDay())
        .executeTakeFirstOrThrow();

      if (Number(count) > DAILY_EMAIL_CAP) {
        // Remove the claim so a capped attempt does not consume the quota.
        await db.deleteFrom('email_dispatches').where('id', '=', dispatchId).execute();
        return 'skipped_capped';
      }
    }
  } else {
    // The key already exists: a prior attempt for this exact job. If it was
    // sent, this is a duplicate; if not, the prior attempt crashed mid-send
    // and we retry it.
    const existing = await db
      .selectFrom('email_dispatches')
      .select(['id', 'sent_at'])
      .where('dedupe_key', '=', job.dedupeKey)
      .executeTakeFirstOrThrow();

    if (existing.sent_at) {
      return 'skipped_duplicate';
    }
    dispatchId = existing.id;
  }

  await mailer.send(job.message);

  await db
    .updateTable('email_dispatches')
    .set({ sent_at: new Date() })
    .where('id', '=', dispatchId)
    .execute();

  return 'sent';
}
