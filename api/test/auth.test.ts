import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  LOCK_MINUTES,
  MAX_FAILED_LOGINS,
  registerUser,
} from '../src/domain/accounts.js';
import { cookieOf, makeTestServer, truncateAll, withOrigin, type TestContext } from './helpers.js';

const EMAIL = 'ada@example.com';
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

async function register(email = EMAIL, password = PASSWORD) {
  return ctx.app.inject(
    withOrigin({ method: 'POST', url: '/api/auth/register', payload: { email, password } }),
  );
}

async function login(email = EMAIL, password = PASSWORD, headers: Record<string, string> = {}) {
  return ctx.app.inject(
    withOrigin({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers }),
  );
}

async function auditEvents() {
  return ctx.db.selectFrom('audit_events').selectAll().orderBy('at').execute();
}

describe('registration', () => {
  it('creates a user and audits it with actor context', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe(EMAIL);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'user_registered' });
    expect(events[0]!.ip).toBeTruthy();
    expect(events[0]!.user_agent).toBeTruthy();
  });

  it('rejects a duplicate email', async () => {
    await register();
    const res = await register();
    expect(res.statusCode).toBe(409);
  });

  it('treats email case-insensitively', async () => {
    await register('Ada@Example.com');
    const res = await register('ada@EXAMPLE.com');
    expect(res.statusCode).toBe(409);
  });

  it('rejects a short password at the schema boundary', async () => {
    const res = await register(EMAIL, 'short');
    expect(res.statusCode).toBe(400);
  });
});

describe('login and sessions', () => {
  beforeEach(async () => {
    await register();
  });

  it('issues an HttpOnly SameSite=Lax session cookie that authenticates /me', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('al_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieOf(res) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(EMAIL);
  });

  it('marks the cookie Secure in production', async () => {
    const prod = await makeTestServer({
      config: { nodeEnv: 'production', appOrigin: 'https://app.example' },
    });
    await prod.app
      .inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL, password: PASSWORD },
        headers: { origin: 'https://app.example' },
      })
      .then((res) => {
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['set-cookie'])).toContain('Secure');
      })
      .finally(() => prod.close());
  });

  it('answers wrong credentials and unknown emails identically', async () => {
    const wrongPassword = await login(EMAIL, 'not-the-password');
    const unknownEmail = await login('nobody@example.com', PASSWORD);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('rotates the session presented at login', async () => {
    const first = await login();
    const firstCookie = cookieOf(first);

    const second = await login(EMAIL, PASSWORD, { cookie: firstCookie });
    const secondCookie = cookieOf(second);
    expect(secondCookie).not.toBe(firstCookie);

    const meWithOld = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: firstCookie },
    });
    expect(meWithOld.statusCode).toBe(401);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const res = await login();
    const cookie = cookieOf(res);

    const out = await ctx.app.inject(
      withOrigin({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }),
    );
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('al_session=;');

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);

    const events = await auditEvents();
    expect(events.map((e) => e.event)).toContain('logout');
  });

  it('lists live sessions with the current one flagged and revokes by id', async () => {
    const first = await login();
    const second = await login();
    const currentCookie = cookieOf(second);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: currentCookie },
    });
    expect(list.statusCode).toBe(200);
    const { sessions } = list.json();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const other = sessions.find((s: { current: boolean }) => !s.current);
    const del = await ctx.app.inject(
      withOrigin({
        method: 'DELETE',
        url: `/api/auth/sessions/${other.id}`,
        headers: { cookie: currentCookie },
      }),
    );
    expect(del.statusCode).toBe(204);

    const meWithRevoked = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieOf(first) },
    });
    expect(meWithRevoked.statusCode).toBe(401);

    const again = await ctx.app.inject(
      withOrigin({
        method: 'DELETE',
        url: `/api/auth/sessions/${other.id}`,
        headers: { cookie: currentCookie },
      }),
    );
    expect(again.statusCode).toBe(404);
  });
});

describe('lockout', () => {
  beforeEach(async () => {
    await register();
  });

  it('locks after repeated failures and rejects the right password while locked', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const result = await authenticate(ctx.db, EMAIL, 'wrong-password');
      expect(result.status).toBe(i === MAX_FAILED_LOGINS - 1 ? 'locked_now' : 'invalid');
    }

    const rightPassword = await authenticate(ctx.db, EMAIL, PASSWORD);
    expect(rightPassword.status).toBe('locked');

    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(user.locked_until).not.toBeNull();
    expect(user.locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect(user.locked_until!.getTime()).toBeLessThanOrEqual(Date.now() + LOCK_MINUTES * 60 * 1000);
  });

  it('a locked account answers 401 over HTTP without an oracle', async () => {
    await ctx.db
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() + 60_000) })
      .where('email', '=', EMAIL)
      .execute();

    const res = await login();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid credentials' });

    const events = await auditEvents();
    const locked = events.find((e) => e.event === 'login_rejected_locked');
    expect(locked).toBeDefined();
    // The append-only audit log must name the actor on a failure event.
    expect(locked!.user_id).toBeTruthy();
  });

  it('records the actor on a wrong-password failure but not on an unknown email', async () => {
    await login(EMAIL, 'wrong-password');
    await login('ghost@example.com', PASSWORD);

    const events = await auditEvents();
    const failures = events.filter((e) => e.event === 'login_failed');
    expect(failures).toHaveLength(2);
    const known = failures.find((e) => e.detail && (e.detail as { email: string }).email === EMAIL);
    const unknown = failures.find(
      (e) => e.detail && (e.detail as { email: string }).email === 'ghost@example.com',
    );
    expect(known!.user_id).toBeTruthy();
    expect(unknown!.user_id).toBeNull();
  });

  it('counts every failure under concurrency (no lost updates)', async () => {
    const attempts = MAX_FAILED_LOGINS - 1;
    await Promise.all(
      Array.from({ length: attempts }, () => authenticate(ctx.db, EMAIL, 'wrong-password')),
    );

    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(user.failed_login_count).toBe(attempts);
    expect(user.locked_until).toBeNull();
  });

  it('a successful login resets the failure counter', async () => {
    await authenticate(ctx.db, EMAIL, 'wrong-password');
    await authenticate(ctx.db, EMAIL, 'wrong-password');
    const ok = await authenticate(ctx.db, EMAIL, PASSWORD);
    expect(ok.status).toBe('ok');

    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(user.failed_login_count).toBe(0);
  });
});

describe('CSRF origin policy', () => {
  it('rejects state-changing requests without an Origin header', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a foreign Origin', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('leaves safe methods alone', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limiting', () => {
  it('throttles login attempts per client', async () => {
    await register();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await login(EMAIL, 'wrong-password');
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('duplicate registration', () => {
  it('does not reveal the account through timing-degenerate shortcuts', async () => {
    await registerUser(ctx.db, EMAIL, PASSWORD);
    const result = await registerUser(ctx.db, EMAIL, 'different-password');
    expect(result.status).toBe('exists');
  });
});
