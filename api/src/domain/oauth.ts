import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  Configuration,
  customFetch,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { User } from './sessions.js';

export type OAuthProvider = 'google' | 'github';

export interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
}

export interface AuthorizationStart {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string | null;
}

export interface OAuthClient {
  begin(redirectUri: string): Promise<AuthorizationStart>;
  complete(input: {
    callbackUrl: string;
    codeVerifier: string;
    state: string;
    nonce: string | null;
  }): Promise<OAuthProfile>;
}

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

// customFetch lets tests point the provider's network calls at a stub without
// a real Google or GitHub.
type FetchLike = typeof fetch;

async function googleConfig(
  creds: OAuthProviderCredentials,
  fetchImpl?: FetchLike,
): Promise<Configuration> {
  // The custom fetch must reach discovery itself, or the well-known lookup goes
  // to the real Google before the stub can take over.
  const config = await discovery(
    new URL('https://accounts.google.com'),
    creds.clientId,
    creds.clientSecret,
    undefined,
    fetchImpl ? { [customFetch]: fetchImpl } : undefined,
  );
  if (fetchImpl) {
    config[customFetch] = fetchImpl;
  }
  return config;
}

function githubConfig(creds: OAuthProviderCredentials, fetchImpl?: FetchLike): Configuration {
  // GitHub is OAuth2, not OIDC: no discovery, no id_token, so the profile comes
  // from its user API.
  const config = new Configuration(
    {
      issuer: 'https://github.com',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
    },
    creds.clientId,
    creds.clientSecret,
  );
  if (fetchImpl) {
    config[customFetch] = fetchImpl;
  }
  return config;
}

async function authorizationStart(
  config: Configuration,
  redirectUri: string,
  scope: string,
  useNonce: boolean,
): Promise<AuthorizationStart> {
  const state = randomState();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const nonce = useNonce ? randomNonce() : null;

  const params: Record<string, string> = {
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  };
  if (nonce) {
    params.nonce = nonce;
  }

  return { url: buildAuthorizationUrl(config, params).href, state, codeVerifier, nonce };
}

export function googleClient(creds: OAuthProviderCredentials, fetchImpl?: FetchLike): OAuthClient {
  // Discovery metadata is stable, so fetch it once per client and reuse it;
  // openid-client refetches JWKS within the cached config on key rotation. A
  // failed discovery is not cached, or the client would stay wedged.
  let configPromise: Promise<Configuration> | undefined;
  function config(): Promise<Configuration> {
    if (!configPromise) {
      configPromise = googleConfig(creds, fetchImpl).catch((err) => {
        configPromise = undefined;
        throw err;
      });
    }
    return configPromise;
  }

  return {
    async begin(redirectUri) {
      return authorizationStart(await config(), redirectUri, 'openid email', true);
    },
    async complete({ callbackUrl, codeVerifier, state, nonce }) {
      const tokens = await authorizationCodeGrant(await config(), new URL(callbackUrl), {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce ?? undefined,
      });
      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new Error('google id token missing subject');
      }
      return {
        providerUserId: String(claims.sub),
        email: typeof claims.email === 'string' ? claims.email : null,
        emailVerified: claims.email_verified === true,
      };
    },
  };
}

interface GithubAccount {
  id: number;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function githubClient(creds: OAuthProviderCredentials, fetchImpl?: FetchLike): OAuthClient {
  // The profile comes from GitHub's REST API, so those calls go through the
  // same fetch the token exchange uses.
  const doFetch: FetchLike = fetchImpl ?? fetch;
  const apiHeaders = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'authledger',
  });

  return {
    async begin(redirectUri) {
      return authorizationStart(
        githubConfig(creds, fetchImpl),
        redirectUri,
        'read:user user:email',
        false,
      );
    },
    async complete({ callbackUrl, codeVerifier, state }) {
      const tokens = await authorizationCodeGrant(
        githubConfig(creds, fetchImpl),
        new URL(callbackUrl),
        {
          pkceCodeVerifier: codeVerifier,
          expectedState: state,
        },
      );
      const headers = apiHeaders(tokens.access_token);
      const account = (await (
        await doFetch('https://api.github.com/user', { headers })
      ).json()) as GithubAccount;
      const emails = (await (
        await doFetch('https://api.github.com/user/emails', { headers })
      ).json()) as GithubEmail[];

      // Read the verified addresses directly rather than trusting the public
      // profile email, which is null when the user keeps it private. Only a
      // verified address may stand in for identity; prefer the primary one.
      const verified = emails.filter((e) => e.verified);
      const chosen = verified.find((e) => e.primary) ?? verified[0] ?? null;
      return {
        providerUserId: String(account.id),
        email: chosen?.email ?? null,
        emailVerified: chosen !== null,
      };
    },
  };
}

// Resolves an OAuth profile to a user, applying the linking rules: an existing
// identity logs in; otherwise a verified email matching an existing account
// links to it; otherwise a new OAuth-only account is created. The boolean says
// whether a fresh account was made (for auditing).
export async function resolveOAuthUser(
  db: Kysely<DB>,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<{ user: User; created: boolean }> {
  const existing = await db
    .selectFrom('provider_identities')
    .innerJoin('users', 'users.id', 'provider_identities.user_id')
    .selectAll('users')
    .where('provider_identities.provider', '=', provider)
    .where('provider_identities.provider_user_id', '=', profile.providerUserId)
    .executeTakeFirst();
  if (existing) {
    return { user: existing, created: false };
  }

  // A synthetic address for accounts created without a usable verified email,
  // so an unverified or already-taken provider email is never claimed.
  const syntheticEmail = `${provider}-${profile.providerUserId}@users.noreply.authledger`;

  return db.transaction().execute(async (trx) => {
    async function createLinked(email: string, verified: boolean) {
      const user = await trx
        .insertInto('users')
        .values({
          email,
          password_hash: null,
          email_verified_at: verified ? new Date() : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('provider_identities')
        .values({ user_id: user.id, provider, provider_user_id: profile.providerUserId })
        .execute();
      return { user, created: true };
    }

    // Only a verified provider email may touch an existing account: link to it
    // if it exists, otherwise create a new account owning that address. An
    // unverified email is never allowed to claim or hijack an address.
    if (profile.email && profile.emailVerified) {
      const byEmail = await trx
        .selectFrom('users')
        .selectAll()
        .where('email', '=', profile.email)
        .executeTakeFirst();
      if (byEmail) {
        await trx
          .insertInto('provider_identities')
          .values({ user_id: byEmail.id, provider, provider_user_id: profile.providerUserId })
          .execute();
        return { user: byEmail, created: false };
      }
      return createLinked(profile.email, true);
    }

    return createLinked(syntheticEmail, false);
  });
}
