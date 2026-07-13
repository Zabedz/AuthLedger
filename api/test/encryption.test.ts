import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/domain/encryption.js';

describe('AES-256-GCM encryption', () => {
  const key = randomBytes(32);

  it('round-trips a secret', () => {
    const blob = encrypt('JBSWY3DPEHPK3PXP', key);
    expect(decrypt(blob, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces different ciphertext each time (random iv)', () => {
    expect(encrypt('same', key).equals(encrypt('same', key))).toBe(false);
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encrypt('secret', key);
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
  });

  it('fails to decrypt a tampered blob (auth tag)', () => {
    const blob = encrypt('secret', key);
    const last = blob.length - 1;
    blob.writeUInt8(blob.readUInt8(last) ^ 0xff, last);
    expect(() => decrypt(blob, key)).toThrow();
  });
});
