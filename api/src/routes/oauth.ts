import { Type } from '@sinclair/typebox';
import { oauthProvidersSchema } from '@authledger/shared';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { recordAudit } from '../domain/audit.js';
import { resolveOAuthUser, type OAuthClient, type OAuthProvider } from '../domain/oauth.js';
import { beginMfaChallenge, completeLogin, requestContextOf, type RouteDeps } from './deps.js';

const OAUTH_STATE_COOKIE = 'al_oauth_state';
const FLOW_TTL_MINUTES = 10;

export interface OAuthDeps extends RouteDeps {
  // One client per configured provider; injected so tests supply stubs.
  clients: Partial<Record<OAuthProvider, OAuthClient>>;
}

export const oauthRoutes: FastifyPluginAsyncTypebox<OAuthDeps> = async (app, deps) => {
  const { config, db, clients } = deps;

  function redirectUri(provider: OAuthProvider): string {
    return `${config.appOrigin}/api/auth/oauth/${provider}/callback`;
  }

  function providerFrom(value: string): OAuthProvider | null {
    return value === 'google' || value === 'github' ? value : null;
  }

  // Public: lets the sign-in screen show buttons only for wired-up providers.
  app.get(
    '/providers',
    { config: { policy: 'public' }, schema: { response: { 200: oauthProvidersSchema } } },
    async () => ({ providers: Object.keys(clients) }),
  );

  app.get(
    '/:provider/start',
    {
      config: { policy: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { params: Type.Object({ provider: Type.String() }) },
    },
    async (req, reply) => {
      const provider = providerFrom(req.params.provider);
      const client = provider ? clients[provider] : undefined;
      if (!provider || !client) {
        return reply.code(404).send({ error: 'unknown provider' });
      }

      const start = await client.begin(redirectUri(provider));
      await db
        .insertInto('oauth_flows')
        .values({
          state: start.state,
          provider,
          code_verifier: start.codeVerifier,
          nonce: start.nonce,
          expires_at: new Date(Date.now() + FLOW_TTL_MINUTES * 60 * 1000),
        })
        .execute();

      // Bind the flow to this browser: the callback must present the same
      // state in a cookie, so a stolen state alone cannot complete a login.
      reply.setCookie(OAUTH_STATE_COOKIE, start.state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
        path: '/api/auth/oauth',
        maxAge: FLOW_TTL_MINUTES * 60,
      });
      return reply.redirect(start.url);
    },
  );

  app.get(
    '/:provider/callback',
    {
      config: {
        policy: 'public',
        skipOriginCheck: true,
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        params: Type.Object({ provider: Type.String() }),
        querystring: Type.Object({
          state: Type.Optional(Type.String()),
          code: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const provider = providerFrom(req.params.provider);
      const client = provider ? clients[provider] : undefined;
      if (!provider || !client) {
        return reply.code(404).send({ error: 'unknown provider' });
      }

      const cookieState = req.cookies[OAUTH_STATE_COOKIE];
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth/oauth' });

      // The state in the URL must match the one bound to this browser.
      if (!req.query.state || !cookieState || req.query.state !== cookieState) {
        return reply.code(400).send({ error: 'invalid oauth state' });
      }

      // Consume the flow: single-use and expiring.
      const flow = await db
        .deleteFrom('oauth_flows')
        .where('state', '=', req.query.state)
        .where('provider', '=', provider)
        .where('expires_at', '>', new Date())
        .returningAll()
        .executeTakeFirst();
      if (!flow) {
        return reply.code(400).send({ error: 'invalid oauth state' });
      }

      const ctx = requestContextOf(req);
      let user;
      let created;
      try {
        const profile = await client.complete({
          callbackUrl: `${config.appOrigin}${req.url}`,
          codeVerifier: flow.code_verifier,
          state: flow.state,
          nonce: flow.nonce,
        });
        ({ user, created } = await resolveOAuthUser(db, provider, profile));
      } catch (err) {
        req.log.warn({ err, provider }, 'oauth callback failed');
        return reply.redirect(`${config.appOrigin}/?oauth_error=1`);
      }

      await recordAudit(db, {
        event: created ? 'oauth_account_created' : 'oauth_login',
        userId: user.id,
        ...ctx,
        detail: { provider },
      });

      // A linked account with MFA still owes a second factor: set the challenge
      // cookie and send the browser to the SPA's MFA screen, never a session.
      if (user.totp_enabled_at !== null) {
        await beginMfaChallenge(deps, reply, user.id, ctx);
        return reply.redirect(`${config.appOrigin}/mfa`);
      }

      await completeLogin(deps, reply, user, ctx, req.auth?.session ?? null);
      return reply.redirect(config.appOrigin);
    },
  );
};
