import argon2 from 'argon2';

// OWASP first-choice configuration: argon2id, 64 MiB, 3 iterations. Asserted
// by test against the hash prefix so a dependency bump cannot silently
// weaken it.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// Verified against when the email does not exist, so response timing does not
// reveal which addresses are registered.
export const timingDummyHash = await argon2.hash('timing-equalizer', HASH_OPTIONS);
