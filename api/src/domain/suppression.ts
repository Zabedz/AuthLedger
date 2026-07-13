import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export type SuppressionReason = 'bounce' | 'complaint';

export async function suppressAddress(
  db: Kysely<DB>,
  address: string,
  reason: SuppressionReason,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insertInto('email_suppressions')
    .values({ address, reason, detail: JSON.stringify(detail) })
    // A later bounce for an already-suppressed address refreshes the reason.
    .onConflict((oc) =>
      oc.column('address').doUpdateSet({ reason, detail: JSON.stringify(detail) }),
    )
    .execute();
}

export async function isSuppressed(db: Kysely<DB>, address: string): Promise<boolean> {
  const row = await db
    .selectFrom('email_suppressions')
    .select('address')
    .where('address', '=', address)
    .executeTakeFirst();
  return row !== undefined;
}
