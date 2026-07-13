import { describe, expect, it } from 'vitest';
import { googleClient } from '../src/domain/oauth.js';
import { OidcStub } from './oidc-stub.js';

// Exercises the real openid-client wiring (discovery, PKCE token exchange, and
// id_token signature/issuer/audience/nonce validation) against an in-process
// stub OpenID provider, so the Google path is proven end to end without Google.
describe('openid-client against a stub OIDC provider', () => {
  it('completes discovery, PKCE, and id_token validation', async () => {
    const stub = await OidcStub.create();
    const client = googleClient(
      { clientId: stub.clientId, clientSecret: 'stub-secret' },
      stub.fetch,
    );

    const start = await client.begin('https://app.example/callback');
    expect(start.url).toContain('code_challenge');
    expect(start.nonce).toBeTruthy();

    stub.setClaims({
      sub: 'google-subject-123',
      email: 'person@example.com',
      email_verified: true,
      nonce: start.nonce!,
    });

    const profile = await client.complete({
      callbackUrl: `https://app.example/callback?code=the-code&state=${start.state}&iss=https%3A%2F%2Faccounts.google.com`,
      codeVerifier: start.codeVerifier,
      state: start.state,
      nonce: start.nonce,
    });

    expect(profile).toEqual({
      providerUserId: 'google-subject-123',
      email: 'person@example.com',
      emailVerified: true,
    });
  });

  it('rejects an id_token whose nonce does not match', async () => {
    const stub = await OidcStub.create();
    const client = googleClient(
      { clientId: stub.clientId, clientSecret: 'stub-secret' },
      stub.fetch,
    );
    const start = await client.begin('https://app.example/callback');

    stub.setClaims({
      sub: 's',
      email: 'e@example.com',
      email_verified: true,
      nonce: 'a-different-nonce',
    });

    await expect(
      client.complete({
        callbackUrl: `https://app.example/callback?code=c&state=${start.state}&iss=https%3A%2F%2Faccounts.google.com`,
        codeVerifier: start.codeVerifier,
        state: start.state,
        nonce: start.nonce,
      }),
    ).rejects.toThrow();
  });
});
