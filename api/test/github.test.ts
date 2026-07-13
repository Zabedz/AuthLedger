import { describe, expect, it } from 'vitest';
import { githubClient } from '../src/domain/oauth.js';

// A stub for GitHub's OAuth2 token endpoint and the two REST calls the client
// makes, wired through customFetch so no network is involved.
function githubStub(account: { id: number }, emails: object[]): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url === 'https://github.com/login/oauth/access_token') {
      return json({ access_token: 'gh-access-token', token_type: 'bearer', scope: 'read:user' });
    }
    if (url === 'https://api.github.com/user') return json(account);
    if (url === 'https://api.github.com/user/emails') return json(emails);
    throw new Error(`unexpected github request: ${url}`);
  };
}

async function login(stub: typeof fetch) {
  const client = githubClient({ clientId: 'gh-id', clientSecret: 'gh-secret' }, stub);
  const start = await client.begin('https://app.example/callback');
  return client.complete({
    callbackUrl: `https://app.example/callback?code=the-code&state=${start.state}`,
    codeVerifier: start.codeVerifier,
    state: start.state,
    nonce: null,
  });
}

describe('github oauth client', () => {
  it('takes identity from the verified primary email, not the public profile', async () => {
    const profile = await login(
      githubStub({ id: 42 }, [
        { email: 'old@example.com', primary: false, verified: true },
        { email: 'primary@example.com', primary: true, verified: true },
      ]),
    );
    expect(profile).toEqual({
      providerUserId: '42',
      email: 'primary@example.com',
      emailVerified: true,
    });
  });

  it('does not treat an unverified email as verified', async () => {
    const profile = await login(
      githubStub({ id: 7 }, [{ email: 'unverified@example.com', primary: true, verified: false }]),
    );
    expect(profile).toEqual({ providerUserId: '7', email: null, emailVerified: false });
  });
});
