import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTestServer, withOrigin, type TestContext } from './helpers.js';

let ctx: TestContext;

afterAll(async () => {
  await ctx?.close();
});

describe('log redaction', () => {
  it('never lets credentials or cookies reach a log line', async () => {
    const lines: string[] = [];
    const capture = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });

    ctx = await makeTestServer({ config: { logLevel: 'info' } }, capture);

    const secretCookie = 'al_session=super-secret-session-token';
    const secretBearer = 'Bearer super-secret-access-token';

    await ctx.app.inject(
      withOrigin({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ada@example.com', password: 'irrelevant-here' },
        headers: { cookie: secretCookie, authorization: secretBearer },
      }),
    );

    const joined = lines.join('\n');
    expect(joined.length).toBeGreaterThan(0);
    expect(joined).not.toContain('super-secret-session-token');
    expect(joined).not.toContain('super-secret-access-token');
  });
});
