import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import type { OAuthClient, OAuthProfile } from '../src/domain/oauth.js';
import { makeTestServer, truncateAll, type TestContext } from './helpers.js';

// A stub client that skips the provider round-trip: begin returns the state we
// will replay, complete returns a fixed profile. This exercises the route's
// linking, CSRF, and MFA logic without a network.
function stubClient(profile: OAuthProfile): OAuthClient {
  return {
    async begin() {
      return {
        url: 'https://provider.example/authorize?state=stub-state',
        state: 'stub-state',
        codeVerifier: 'stub-verifier',
        nonce: 'stub-nonce',
      };
    },
    async complete() {
      return profile;
    },
  };
}

let ctx: TestContext;
let profile: OAuthProfile;

const crypto = new NobleCryptoPlugin();
const base32 = new ScureBase32Plugin();

async function build(p: OAuthProfile) {
  profile = p;
  ctx = await makeTestServer({
    oauthClients: {
      google: {
        begin: (...a) => stubClient(profile).begin(...a),
        complete: (...a) => stubClient(profile).complete(...a),
      },
    },
  });
  await truncateAll(ctx.db);
}

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx?.close();
});

// Drives /start then /callback, carrying the state cookie between them.
async function oauthLogin(overrides: { urlState?: string; cookieState?: string } = {}) {
  const start = await ctx.app.inject({ method: 'GET', url: '/api/auth/oauth/google/start' });
  const stateCookie = String(start.headers['set-cookie']).match(/al_oauth_state=([^;]+)/)?.[1];
  const urlState = overrides.urlState ?? 'stub-state';
  const cookie =
    overrides.cookieState !== undefined
      ? `al_oauth_state=${overrides.cookieState}`
      : `al_oauth_state=${stateCookie}`;
  return ctx.app.inject({
    method: 'GET',
    url: `/api/auth/oauth/google/callback?state=${urlState}&code=abc`,
    headers: { cookie },
  });
}

describe('OAuth login', () => {
  it('creates an account on first login and sets a session', async () => {
    await build({ providerUserId: 'g-1', email: 'new@example.com', emailVerified: true });
    const res = await oauthLogin();
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['set-cookie'])).toContain('al_session=');

    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', 'new@example.com')
      .executeTakeFirst();
    expect(user?.password_hash).toBeNull();
    expect(user?.email_verified_at).not.toBeNull();
    const kinds = (await ctx.db.selectFrom('audit_events').select('event').execute()).map(
      (r) => r.event,
    );
    expect(kinds).toContain('oauth_account_created');
  });

  it('links to an existing account with a matching verified email', async () => {
    await build({ providerUserId: 'g-2', email: 'existing@example.com', emailVerified: true });
    const existing = await ctx.db
      .insertInto('users')
      .values({ email: 'existing@example.com', password_hash: 'x', email_verified_at: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();

    await oauthLogin();
    const link = await ctx.db
      .selectFrom('provider_identities')
      .selectAll()
      .where('provider_user_id', '=', 'g-2')
      .executeTakeFirstOrThrow();
    expect(link.user_id).toBe(existing.id);
    // No duplicate user was created.
    const count = await ctx.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });

  it('does not link on an unverified provider email', async () => {
    await build({ providerUserId: 'g-3', email: 'existing@example.com', emailVerified: false });
    await ctx.db
      .insertInto('users')
      .values({ email: 'existing@example.com', password_hash: 'x' })
      .execute();

    await oauthLogin();
    // A separate account was created rather than hijacking the existing one.
    const count = await ctx.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(2);
  });

  it('logs into the same account on a repeat login', async () => {
    await build({ providerUserId: 'g-4', email: 'repeat@example.com', emailVerified: true });
    await oauthLogin();
    await oauthLogin();
    const count = await ctx.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .executeTakeFirstOrThrow();
    expect(Number(count.c)).toBe(1);
  });
});

describe('OAuth CSRF binding', () => {
  it('rejects a callback whose state cookie does not match the URL', async () => {
    await build({ providerUserId: 'g-5', email: 'a@example.com', emailVerified: true });
    const res = await oauthLogin({ cookieState: 'a-different-state' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a callback with no state cookie (unbound flow)', async () => {
    await build({ providerUserId: 'g-6', email: 'b@example.com', emailVerified: true });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/oauth/google/callback?state=stub-state&code=abc',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('OAuth does not bypass MFA', () => {
  it('a linked account with MFA gets a challenge, not a session', async () => {
    await build({ providerUserId: 'g-7', email: 'mfa@example.com', emailVerified: true });
    // Create the account via a first OAuth login, then enable MFA on it.
    await oauthLogin();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const { encrypt } = await import('../src/domain/encryption.js');
    // The test server's encryption key (see testConfig).
    await ctx.db
      .updateTable('users')
      .set({ totp_secret: encrypt(secret, Buffer.alloc(32, 9)), totp_enabled_at: new Date() })
      .where('email', '=', 'mfa@example.com')
      .execute();

    const res = await oauthLogin();
    // Redirected to the MFA screen with a challenge cookie, no session.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/mfa$/);
    const cookies = String(res.headers['set-cookie']);
    expect(cookies).toContain('al_mfa=');
    expect(cookies).not.toContain('al_session=');

    // The challenge cookie exchanges for a session with a valid TOTP.
    const challenge = cookies.match(/al_mfa=([^;]+)/)?.[1];
    const code = await new TOTP({ secret, issuer: 'authledger', crypto, base32 }).generate();
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa',
      headers: { origin: 'http://localhost:5173', cookie: `al_mfa=${challenge}` },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    expect(String(verify.headers['set-cookie'])).toContain('al_session=');
  });
});

describe('unconfigured provider', () => {
  it('returns 404 when the provider has no client', async () => {
    await build({ providerUserId: 'g-8', email: 'x@example.com', emailVerified: true });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/oauth/github/start' });
    expect(res.statusCode).toBe(404);
  });
});
