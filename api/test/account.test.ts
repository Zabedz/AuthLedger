import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieOf,
  makeTestServer,
  tokenFromEmail,
  truncateAll,
  withOrigin,
  type TestContext,
} from './helpers.js';

const EMAIL = 'grace@example.com';
const PASSWORD = 'correct-horse-battery';

let ctx: TestContext;

beforeEach(async () => {
  if (ctx) {
    await ctx.close();
  }
  ctx = await makeTestServer();
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

function post(url: string, payload: object, headers: Record<string, string> = {}) {
  return ctx.app.inject(withOrigin({ method: 'POST', url, payload, headers }));
}

async function register(email = EMAIL, password = PASSWORD) {
  ctx.sent.length = 0;
  const res = await post('/api/auth/register', { email, password });
  return res;
}

async function login(email = EMAIL, password = PASSWORD) {
  return post('/api/auth/login', { email, password });
}

async function userRow(email = EMAIL) {
  return ctx.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
}

async function auditKinds() {
  const events = await ctx.db.selectFrom('audit_events').select('event').orderBy('at').execute();
  return events.map((e) => e.event);
}

describe('email verification', () => {
  it('verifies with the emailed token', async () => {
    await register();
    const token = tokenFromEmail(ctx.sent[0]!);

    expect((await userRow())!.email_verified_at).toBeNull();

    const res = await post('/api/auth/verify-email', { token });
    expect(res.statusCode).toBe(200);
    expect((await userRow())!.email_verified_at).not.toBeNull();
    expect(await auditKinds()).toContain('email_verified');
  });

  it('rejects a reused token', async () => {
    await register();
    const token = tokenFromEmail(ctx.sent[0]!);
    await post('/api/auth/verify-email', { token });

    const reuse = await post('/api/auth/verify-email', { token });
    expect(reuse.statusCode).toBe(400);
  });

  it('rejects an expired token', async () => {
    await register();
    const token = tokenFromEmail(ctx.sent[0]!);
    await ctx.db
      .updateTable('auth_tokens')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    const res = await post('/api/auth/verify-email', { token });
    expect(res.statusCode).toBe(400);
  });

  it('resend is non-enumerating and only mails a known unverified address', async () => {
    await register();

    ctx.sent.length = 0;
    const unknown = await post('/api/auth/verify-email/resend', { email: 'nobody@example.com' });
    expect(unknown.statusCode).toBe(202);
    expect(ctx.sent).toHaveLength(0);

    const known = await post('/api/auth/verify-email/resend', { email: EMAIL });
    expect(known.statusCode).toBe(202);
    expect(ctx.sent).toHaveLength(1);

    // Verified accounts get no resend.
    const token = tokenFromEmail(ctx.sent[0]!);
    await post('/api/auth/verify-email', { token });
    ctx.sent.length = 0;
    await post('/api/auth/verify-email/resend', { email: EMAIL });
    expect(ctx.sent).toHaveLength(0);
  });
});

describe('password reset', () => {
  it('resets the password, invalidates sessions, and notifies', async () => {
    await register();
    const live = await login();
    const liveCookie = cookieOf(live);

    ctx.sent.length = 0;
    const request = await post('/api/auth/password-reset/request', { email: EMAIL });
    expect(request.statusCode).toBe(202);
    const token = tokenFromEmail(ctx.sent[0]!);

    const reset = await post('/api/auth/password-reset', {
      token,
      password: 'a-brand-new-password',
    });
    expect(reset.statusCode).toBe(200);

    // The session that existed before the reset is dead.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: liveCookie },
    });
    expect(me.statusCode).toBe(401);

    // Old password fails, new one works.
    expect((await login(EMAIL, PASSWORD)).statusCode).toBe(401);
    expect((await login(EMAIL, 'a-brand-new-password')).statusCode).toBe(200);

    expect(await auditKinds()).toContain('password_reset');
    expect(ctx.sent.some((m) => /password (changed|reset)/i.test(m.subject))).toBe(true);
    // A reset also verifies the address.
    expect((await userRow())!.email_verified_at).not.toBeNull();
  });

  it('request is non-enumerating for an unknown email', async () => {
    ctx.sent.length = 0;
    const res = await post('/api/auth/password-reset/request', { email: 'ghost@example.com' });
    expect(res.statusCode).toBe(202);
    expect(ctx.sent).toHaveLength(0);
  });

  it('rejects a reused reset token', async () => {
    await register();
    await post('/api/auth/password-reset/request', { email: EMAIL });
    const token = tokenFromEmail(ctx.sent.at(-1)!);
    await post('/api/auth/password-reset', { token, password: 'first-new-password' });

    const reuse = await post('/api/auth/password-reset', {
      token,
      password: 'second-new-password',
    });
    expect(reuse.statusCode).toBe(400);
  });
});

describe('new-device notification', () => {
  function loginWithAgent(agent: string) {
    return ctx.app.inject(
      withOrigin({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL, password: PASSWORD },
        headers: { 'user-agent': agent },
      }),
    );
  }

  const isNewDevice = (m: { subject: string }) => /new sign-in/i.test(m.subject);

  it('does not notify on the first-ever sign-in, but does from an unfamiliar agent', async () => {
    await register();

    ctx.sent.length = 0;
    await loginWithAgent('Mozilla/5.0 (first device)');
    expect(ctx.sent.filter(isNewDevice)).toHaveLength(0);

    ctx.sent.length = 0;
    await loginWithAgent('Mozilla/5.0 (first device)');
    expect(ctx.sent.filter(isNewDevice)).toHaveLength(0);

    ctx.sent.length = 0;
    await loginWithAgent('Mozilla/5.0 (a different device)');
    expect(ctx.sent.filter(isNewDevice)).toHaveLength(1);
  });
});

describe('account deletion', () => {
  it('removes the user, revokes sessions, audits, and notifies', async () => {
    await register();
    const session = await login();
    const cookie = cookieOf(session);

    ctx.sent.length = 0;
    const del = await ctx.app.inject(
      withOrigin({ method: 'DELETE', url: '/api/auth/account', headers: { cookie } }),
    );
    expect(del.statusCode).toBe(204);
    expect(String(del.headers['set-cookie'])).toContain('al_session=;');

    expect(await userRow()).toBeUndefined();
    const sessions = await ctx.db.selectFrom('sessions').selectAll().execute();
    expect(sessions).toHaveLength(0);
    expect(await auditKinds()).toContain('account_deleted');
    expect(ctx.sent.some((m) => /deleted/i.test(m.subject))).toBe(true);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it('requires authentication', async () => {
    const del = await ctx.app.inject(withOrigin({ method: 'DELETE', url: '/api/auth/account' }));
    expect(del.statusCode).toBe(401);
  });
});
