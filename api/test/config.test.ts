import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'development',
  PORT: '8000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
};

describe('appOrigin', () => {
  it('defaults to the vite dev origin outside production', () => {
    expect(loadConfig(base).appOrigin).toBe('http://localhost:5173');
  });

  it('requires APP_ORIGIN in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/APP_ORIGIN/);
  });

  it('rejects an APP_ORIGIN with a path', () => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'http://x/app' })).toThrow(/APP_ORIGIN/);
  });
});

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(base);
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(8000);
    expect(config.databaseUrl).toBe(base.DATABASE_URL);
    expect(config.stripeSecretKey).toBeUndefined();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...base, PORT: 'http' })).toThrow(/PORT/);
  });

  it('refuses a live Stripe key outside production', () => {
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(/sk_test_/);
  });

  it('accepts a test Stripe key outside production', () => {
    const config = loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(config.stripeSecretKey).toBe('sk_test_abc');
  });

  it('does not gate the key format in production', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://app.example',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      STRIPE_SECRET_KEY: 'sk_live_abc',
    });
    expect(config.stripeSecretKey).toBe('sk_live_abc');
  });

  it('requires ENCRYPTION_KEY in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', APP_ORIGIN: 'https://app.example' }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it('rejects an ENCRYPTION_KEY that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...base, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
  });
});
