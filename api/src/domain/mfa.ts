import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { decrypt, encrypt } from './encryption.js';

const cryptoPlugin = new NobleCryptoPlugin();
const base32Plugin = new ScureBase32Plugin();

const ISSUER = 'authledger';
// Accept the adjacent 30-second step on each side for clock drift.
const EPOCH_TOLERANCE_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
export const MFA_CHALLENGE_TTL_MINUTES = 10;

function totp(secret: string, label?: string): TOTP {
  return new TOTP({ secret, issuer: ISSUER, label, crypto: cryptoPlugin, base32: base32Plugin });
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function newTotpSecret(): string {
  return generateSecret({ crypto: cryptoPlugin, base32: base32Plugin });
}

export function totpUri(secret: string, email: string): string {
  return totp(secret, email).toURI();
}

interface TotpCheck {
  valid: boolean;
  timeStep: number;
}

async function checkTotpCode(secret: string, token: string): Promise<TotpCheck> {
  if (!/^\d{6}$/.test(token)) {
    return { valid: false, timeStep: 0 };
  }
  const result = await totp(secret).verify(token, { epochTolerance: EPOCH_TOLERANCE_SECONDS });
  return { valid: result.valid, timeStep: result.valid ? result.timeStep : 0 };
}

// Stateless check used at enrollment, where there is no prior step to replay.
export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  return (await checkTotpCode(secret, token)).valid;
}

// Stores the encrypted secret without enabling it, so setup can be restarted
// and the secret only gates login once a code confirms it.
export async function stageTotpSecret(
  db: Kysely<DB>,
  userId: string,
  secret: string,
  key: Buffer,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ totp_secret: encrypt(secret, key), totp_enabled_at: null, updated_at: new Date() })
    .where('id', '=', userId)
    .execute();
}

async function loadSecret(db: Kysely<DB>, userId: string, key: Buffer): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('totp_secret')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.totp_secret ? decrypt(row.totp_secret, key) : null;
}

// Confirms the staged secret with a code and turns MFA on, returning fresh
// single-use recovery codes (shown once).
export async function enableTotp(
  db: Kysely<DB>,
  userId: string,
  code: string,
  key: Buffer,
): Promise<{ recoveryCodes: string[] } | null> {
  const secret = await loadSecret(db, userId, key);
  if (!secret || !(await verifyTotpCode(secret, code))) {
    return null;
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(8).toString('hex'),
  );

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ totp_enabled_at: new Date(), totp_last_step: null, updated_at: new Date() })
      .where('id', '=', userId)
      .execute();
    await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    await trx
      .insertInto('mfa_recovery_codes')
      .values(recoveryCodes.map((c) => ({ user_id: userId, code_hash: sha256(c) })))
      .execute();
  });

  return { recoveryCodes };
}

export async function disableTotp(db: Kysely<DB>, userId: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ totp_secret: null, totp_enabled_at: null, updated_at: new Date() })
      .where('id', '=', userId)
      .execute();
    await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
  });
}

// Login-time verification with replay protection: a code is accepted only if
// its time step is newer than the last one accepted for this user, so a code
// captured within its validity window cannot be reused.
export async function verifyTotpForUser(
  db: Kysely<DB>,
  userId: string,
  code: string,
  key: Buffer,
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select(['totp_secret', 'totp_last_step'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.totp_secret) {
    return false;
  }

  const check = await checkTotpCode(decrypt(row.totp_secret, key), code);
  if (!check.valid) {
    return false;
  }

  // bigint columns round-trip as strings through node-postgres.
  const step = String(check.timeStep);

  // The step must advance. An UPDATE guarded on the old value makes two
  // concurrent uses of the same code race to one winner.
  const advanced = await db
    .updateTable('users')
    .set({ totp_last_step: step })
    .where('id', '=', userId)
    .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
    .executeTakeFirst();

  return Number(advanced.numUpdatedRows) > 0;
}

// Recovery codes are single-use: the matching row is consumed atomically so a
// replay finds nothing.
export async function consumeRecoveryCode(
  db: Kysely<DB>,
  userId: string,
  code: string,
): Promise<boolean> {
  const consumed = await db
    .updateTable('mfa_recovery_codes')
    .set({ consumed_at: new Date() })
    .where('user_id', '=', userId)
    .where('code_hash', '=', sha256(code))
    .where('consumed_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return consumed !== undefined;
}

export async function issueMfaChallenge(db: Kysely<DB>, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .insertInto('mfa_challenges')
    .values({
      user_id: userId,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60 * 1000),
    })
    .execute();
  return token;
}

// Consumes a challenge and returns the user it belongs to; single-use and
// time-bounded, the same shape as the reset tokens.
export async function consumeMfaChallenge(
  db: Kysely<DB>,
  token: string,
): Promise<{ userId: string } | null> {
  const consumed = await db
    .updateTable('mfa_challenges')
    .set({ consumed_at: new Date() })
    .where('token_hash', '=', sha256(token))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', new Date())
    .returning('user_id')
    .executeTakeFirst();
  return consumed ? { userId: consumed.user_id } : null;
}
