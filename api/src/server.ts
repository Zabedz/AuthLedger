import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import rateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import type { DB } from './db/types.js';
import type { EmailEnqueuer } from './domain/dispatch.js';
import {
  githubClient,
  googleClient,
  type OAuthClient,
  type OAuthProvider,
} from './domain/oauth.js';
import { loggerOptions, requestContext } from './logging.js';
import { registerAuthzGuard } from './plugins/authz-guard.js';
import { registerOpenapi } from './plugins/openapi.js';
import { registerOriginCheck } from './plugins/origin-check.js';
import { registerSentryErrorHandler } from './plugins/sentry.js';
import { registerSessionAuth } from './plugins/session-auth.js';
import { registerHttpTracing } from './plugins/tracing.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type HealthDeps } from './routes/health.js';
import { mfaRoutes } from './routes/mfa.js';
import { oauthRoutes } from './routes/oauth.js';
import { paymentRoutes } from './routes/payments.js';
import { stripeWebhookRoutes } from './routes/stripe-webhooks.js';
import { webhookRoutes } from './routes/webhooks.js';
import { sentryEnabled } from './sentry.js';
import { tracingEnabled } from './tracing.js';

export interface ServerDeps {
  health: HealthDeps;
  db: Kysely<DB>;
  enqueue: EmailEnqueuer;
  // Tests inject stub OAuth clients; production builds them from config.
  oauthClients?: Partial<Record<OAuthProvider, OAuthClient>>;
  // Tests inject a Stripe client; production builds one from config.
  stripe?: Stripe;
}

export interface ServerOptions {
  // Tests capture log output through here to prove redaction.
  loggerStream?: NodeJS.WritableStream;
}

// A sentinel, not a credential: the Stripe client falls back to it when no key
// is set, which is enough for webhook signature verification (HMAC only).
const STRIPE_NO_API_KEY = 'stripe-api-key-unused-for-webhook-verification';

export async function buildServer(
  config: Config,
  deps: ServerDeps,
  opts: ServerOptions = {},
): Promise<FastifyInstance> {
  const baseLogger = loggerOptions(config);
  const app = Fastify({
    logger: opts.loggerStream ? { ...baseLogger, stream: opts.loggerStream } : baseLogger,
    logController: new LogController({ requestIdLogLabel: 'req_id' }),
    // Behind the ALB the client address arrives in x-forwarded-for.
    trustProxy: config.nodeEnv === 'production',
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && /^[\w.-]{1,128}$/.test(inbound)
        ? inbound
        : randomUUID();
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onRequest', (req, _reply, done) => {
    requestContext.run({ requestId: req.id }, done);
  });

  // Registered after the request-id hook so the span context nests inside it and
  // stays active for the whole request. Gated by the same predicate that decides
  // whether startTracing registers a provider, so the two never disagree.
  if (tracingEnabled(config)) {
    registerHttpTracing(app);
  }

  // Report server errors to Sentry when a DSN is set (startSentry initializes the
  // client in the entrypoint); the handler filters to 5xx.
  if (sentryEnabled(config)) {
    registerSentryErrorHandler(app);
  }

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  registerOriginCheck(app, config);
  if (config.rateLimitEnabled) {
    await app.register(rateLimit, { global: false });
  }
  await registerSessionAuth(app, config, deps.db);
  registerAuthzGuard(app);
  await registerOpenapi(app, config);

  const routeDeps = { config, db: deps.db, enqueue: deps.enqueue };
  const oauthClients = deps.oauthClients ?? buildOAuthClients(config);
  // One Stripe client, shared by the payment and webhook routes. constructEvent
  // needs no live key, so a sentinel is fine when only verifying webhooks.
  const stripe = deps.stripe ?? new Stripe(config.stripeSecretKey ?? STRIPE_NO_API_KEY);
  await app.register(healthRoutes, { prefix: '/api', deps: deps.health });
  await app.register(authRoutes, { prefix: '/api/auth', ...routeDeps });
  await app.register(accountRoutes, { prefix: '/api/auth', ...routeDeps });
  await app.register(mfaRoutes, { prefix: '/api/auth/mfa', ...routeDeps });
  await app.register(adminRoutes, { prefix: '/api/admin', ...routeDeps, stripe });
  await app.register(paymentRoutes, { prefix: '/api/payments', ...routeDeps, stripe });
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks', config, db: deps.db, stripe });
  await app.register(oauthRoutes, {
    prefix: '/api/auth/oauth',
    ...routeDeps,
    clients: oauthClients,
  });
  // The SES webhook is only safe once a topic is pinned (a valid SNS signature
  // alone does not bind a message to our topic), so in production the route
  // does not exist until SES_SNS_TOPIC_ARN is set. Dev and CI register it
  // unpinned for local testing but are not internet-exposed.
  if (config.nodeEnv !== 'production' || config.sesSnsTopicArn) {
    await app.register(webhookRoutes, { prefix: '/api/webhooks', config, db: deps.db });
  }

  return app;
}

function buildOAuthClients(config: Config): Partial<Record<OAuthProvider, OAuthClient>> {
  const clients: Partial<Record<OAuthProvider, OAuthClient>> = {};
  if (config.oauth.google) {
    clients.google = googleClient(config.oauth.google);
  }
  if (config.oauth.github) {
    clients.github = githubClient(config.oauth.github);
  }
  return clients;
}
