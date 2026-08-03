import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/domain/passwords.js';

describe('password hashing', () => {
  it('produces argon2id hashes with the pinned parameters', async () => {
    const hash = await hashPassword('a-perfectly-fine-password');
    // OWASP-aligned parameters; a dependency bump must not weaken them.
    // argon2 encodes them in its own order (0.44 emits m,t,p and 0.45 m,p,t),
    // so compare the set rather than the literal prefix.
    const [, variant, version, params = ''] = hash.split('$');
    expect(variant).toBe('argon2id');
    expect(version).toBe('v=19');
    expect(params.split(',').sort()).toEqual(['m=65536', 'p=4', 't=3']);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('a-perfectly-fine-password');
    expect(await verifyPassword(hash, 'a-perfectly-fine-password')).toBe(true);
    expect(await verifyPassword(hash, 'not-that-password')).toBe(false);
  });

  it('does not truncate long passwords', async () => {
    const long = 'x'.repeat(150);
    const hash = await hashPassword(long);
    expect(await verifyPassword(hash, long)).toBe(true);
    expect(await verifyPassword(hash, long.slice(0, 72))).toBe(false);
  });

  it('salts: the same password hashes differently twice', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
  });
});
