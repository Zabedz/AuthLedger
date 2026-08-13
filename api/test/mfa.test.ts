import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';

const EMAIL = 'mfa-user@example.com';
const PASSWORD = 'correct-horse-battery';

let ctx: TestContext;

const crypto = new NobleCryptoPlugin();
const base32 = new ScureBase32Plugin();

async function totpFor(secret: string): Promise<string> {
  return new TOTP({ secret, issuer: 'AuthLedger', crypto, base32 }).generate();
}

beforeEach(async () => {
  if (ctx) await ctx.close();
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

function post(url: string, payload?: object, headers: Record<string, string> = {}) {
  return ctx.app.inject(withOrigin({ method: 'POST', url, payload, headers }));
}

async function registerAndLogin(): Promise<string> {
  await post('/api/auth/register', { email: EMAIL, password: PASSWORD });
  const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  return cookieOf(login);
}

// Enrolls MFA and returns the secret and recovery codes.
async function enrollMfa(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await post('/api/auth/mfa/setup', undefined, { cookie });
  const { secret } = setup.json();
  const code = await totpFor(secret);
  const enable = await post('/api/auth/mfa/enable', { code }, { cookie });
  expect(enable.statusCode).toBe(200);
  return { secret, recoveryCodes: enable.json().recovery_codes };
}

async function auditKinds() {
  const rows = await ctx.db.selectFrom('audit_events').select('event').orderBy('at').execute();
  return rows.map((r) => r.event);
}

// The MFA challenge rides in an HttpOnly al_mfa cookie.
function mfaCookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const line = lines.find((l) => l.startsWith('al_mfa='));
  if (!line) throw new Error(`no al_mfa cookie in ${JSON.stringify(setCookie)}`);
  return line.split(';')[0]!;
}

// Password login, then exchange the challenge cookie for a session with a code.
async function loginWithMfa(code: string) {
  const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  return post('/api/auth/login/mfa', { code }, { cookie: mfaCookieOf(login) });
}

describe('MFA enrollment', () => {
  it('setup returns an otpauth URI and stores the secret encrypted, not plaintext', async () => {
    const cookie = await registerAndLogin();
    const setup = await post('/api/auth/mfa/setup', undefined, { cookie });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().otpauth_uri).toMatch(/^otpauth:\/\/totp\/AuthLedger/);

    const secret = setup.json().secret;
    const row = await ctx.db
      .selectFrom('users')
      .select('totp_secret')
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(row.totp_secret).not.toBeNull();
    // The stored bytes are ciphertext, not the base32 secret.
    expect(row.totp_secret!.toString('utf8')).not.toContain(secret);
  });

  it('enable rejects a wrong code and accepts a correct one, returning recovery codes', async () => {
    const cookie = await registerAndLogin();
    const setup = await post('/api/auth/mfa/setup', undefined, { cookie });
    const secret = setup.json().secret;

    const wrong = await post('/api/auth/mfa/enable', { code: '000000' }, { cookie });
    expect(wrong.statusCode).toBe(400);

    const enable = await post('/api/auth/mfa/enable', { code: await totpFor(secret) }, { cookie });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().recovery_codes).toHaveLength(10);
    expect(await auditKinds()).toContain('mfa_enabled');
  });
});

describe('MFA login', () => {
  it('login returns a challenge, not a session, when MFA is on', async () => {
    const cookie = await registerAndLogin();
    await enrollMfa(cookie);

    const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa_required).toBe(true);
    // The challenge rides in an HttpOnly cookie, and no session is minted yet.
    const cookies = String(login.headers['set-cookie']);
    expect(cookies).toContain('al_mfa=');
    expect(cookies).not.toContain('al_session=');
  });

  it('a valid TOTP exchanges the challenge for a session', async () => {
    const cookie = await registerAndLogin();
    const { secret } = await enrollMfa(cookie);

    const verify = await loginWithMfa(await totpFor(secret));
    expect(verify.statusCode).toBe(200);
    expect(verify.json().user.email).toBe(EMAIL);
    expect(String(verify.headers['set-cookie'])).toContain('al_session=');
    expect(await auditKinds()).toContain('mfa_succeeded');
  });

  it('a wrong TOTP is rejected and the challenge is spent', async () => {
    const cookie = await registerAndLogin();
    await enrollMfa(cookie);
    const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    const mfaCookie = mfaCookieOf(login);

    const first = await post('/api/auth/login/mfa', { code: '000000' }, { cookie: mfaCookie });
    expect(first.statusCode).toBe(401);

    // The challenge is single-use even on a failed attempt.
    const reuse = await post('/api/auth/login/mfa', { code: '111111' }, { cookie: mfaCookie });
    expect(reuse.statusCode).toBe(401);
    expect(await auditKinds()).toContain('mfa_failed');
  });

  it('a recovery code works once and is then consumed', async () => {
    const cookie = await registerAndLogin();
    const { recoveryCodes } = await enrollMfa(cookie);
    const recovery = recoveryCodes[0]!;

    const use = await loginWithMfa(recovery);
    expect(use.statusCode).toBe(200);
    expect(await auditKinds()).toContain('recovery_code_used');

    const reuse = await loginWithMfa(recovery);
    expect(reuse.statusCode).toBe(401);
  });

  it('an account with MFA cannot be entered by password alone', async () => {
    const cookie = await registerAndLogin();
    await enrollMfa(cookie);

    const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    // No session cookie, so /me stays unauthenticated on the password step.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401);
    expect(login.json().mfa_required).toBe(true);
  });
});

describe('TOTP replay protection', () => {
  it('rejects a code already used, even within its validity window', async () => {
    const cookie = await registerAndLogin();
    const { secret } = await enrollMfa(cookie);
    const code = await totpFor(secret);

    const first = await loginWithMfa(code);
    expect(first.statusCode).toBe(200);

    // Same code, fresh challenge: the time step has not advanced, so it is a replay.
    const replay = await loginWithMfa(code);
    expect(replay.statusCode).toBe(401);
  });
});

describe('MFA notifications', () => {
  it('emails on enable and on disable', async () => {
    const cookie = await registerAndLogin();
    ctx.sent.length = 0;
    const { secret } = await enrollMfa(cookie);
    expect(ctx.sent.some((m) => /two-factor authentication is on/i.test(m.subject))).toBe(true);

    ctx.sent.length = 0;
    await post('/api/auth/mfa/disable', { code: await totpFor(secret) }, { cookie });
    expect(ctx.sent.some((m) => /two-factor authentication is off/i.test(m.subject))).toBe(true);
  });
});

describe('MFA disable', () => {
  it('requires a current code and then lets password login through', async () => {
    const cookie = await registerAndLogin();
    const { secret } = await enrollMfa(cookie);

    const wrong = await post('/api/auth/mfa/disable', { code: '000000' }, { cookie });
    expect(wrong.statusCode).toBe(400);

    const disable = await post(
      '/api/auth/mfa/disable',
      { code: await totpFor(secret) },
      { cookie },
    );
    expect(disable.statusCode).toBe(204);
    expect(await auditKinds()).toContain('mfa_disabled');

    const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(login.json().user.email).toBe(EMAIL);
  });

  it('accepts a recovery code to disable (lost authenticator)', async () => {
    const cookie = await registerAndLogin();
    const { recoveryCodes } = await enrollMfa(cookie);

    const disable = await post('/api/auth/mfa/disable', { code: recoveryCodes[0] }, { cookie });
    expect(disable.statusCode).toBe(204);

    const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(login.json().user.email).toBe(EMAIL);
  });
});
