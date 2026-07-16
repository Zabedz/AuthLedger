const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface SmtpConfig {
  host: string;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

export interface TracingConfig {
  // Print spans to stdout, for local inspection without a collector.
  consoleExporter: boolean;
  // The OTLP/HTTP collector base endpoint; when set, spans are batch-exported.
  otlpEndpoint: string | undefined;
}

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  appOrigin: string;
  smtp: SmtpConfig;
  tracing: TracingConfig;
  encryptionKey: Buffer;
  oauth: OAuthConfig;
  sesSnsTopicArn: string | undefined;
  stripeSecretKey: string | undefined;
  // The signing secret for the Stripe webhook endpoint (whsec_...); without it
  // the webhook route rejects every delivery.
  stripeWebhookSecret: string | undefined;
  // The publishable key (pk_test_...); public, served to the SPA.
  stripePublishableKey: string | undefined;
  // Sentry error tracking DSN; error reporting is off when unset. The region is
  // read from the DSN.
  sentryDsn: string | undefined;
  // When set, the account with this email is granted the admin role at boot.
  adminEmail: string | undefined;
  // Off only for the browser e2e, where many journeys share one server and one
  // client IP; the per-route limits are still asserted by the api tests.
  rateLimitEnabled: boolean;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  google: OAuthCredentials | undefined;
  github: OAuthCredentials | undefined;
}

function oauthCreds(
  id: string | undefined,
  secret: string | undefined,
): OAuthCredentials | undefined {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

// A fixed key for dev and test only. Production supplies its own via env.
const DEV_ENCRYPTION_KEY = Buffer.alloc(32, 7);

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV ?? 'development') as NodeEnv;
  if (!NODE_ENVS.includes(nodeEnv)) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}; got "${env.NODE_ENV}"`);
  }

  const port = Number(env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535; got "${env.PORT}"`);
  }

  const logLevel = (env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug')) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got "${env.LOG_LEVEL}"`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const appOrigin =
    env.APP_ORIGIN ?? (nodeEnv === 'production' ? undefined : 'http://localhost:5173');
  if (!appOrigin) {
    throw new Error('APP_ORIGIN is required in production (the browser origin of the SPA)');
  }
  // Must equal what a browser sends as Origin: an exact match against the
  // canonical form rejects a default port or an uppercase host, either of
  // which would 403 every state-changing request in production.
  if (!/^https?:\/\//.test(appOrigin) || safeOrigin(appOrigin) !== appOrigin) {
    throw new Error(`APP_ORIGIN must be the canonical scheme://host origin; got "${appOrigin}"`);
  }

  // SMTP covers both environments: Mailpit locally, the SES SMTP endpoint in
  // production. Dev defaults point at the compose Mailpit service.
  const smtpPort = Number(env.SMTP_PORT ?? 1025);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error(`SMTP_PORT must be an integer between 1 and 65535; got "${env.SMTP_PORT}"`);
  }
  const smtp: SmtpConfig = {
    host: env.SMTP_HOST ?? 'localhost',
    port: smtpPort,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.MAIL_FROM ?? 'authledger <no-reply@authledger.test>',
  };

  const stripeSecretKey = env.STRIPE_SECRET_KEY || undefined;
  if (stripeSecretKey && nodeEnv !== 'production' && !stripeSecretKey.startsWith('sk_test_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must be a test-mode key (sk_test_...) outside production; ` +
        `got a key starting with "${stripeSecretKey.slice(0, 3)}..."`,
    );
  }

  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET || undefined;
  // The publishable key is not secret; the SPA needs it to mount the Payment
  // Element, and the API serves it through a public config endpoint.
  const stripePublishableKey = env.STRIPE_PUBLISHABLE_KEY || undefined;

  // 32-byte AES key (base64) that encrypts TOTP secrets at rest. Required in
  // production; dev and test fall back to a fixed key.
  let encryptionKey = DEV_ENCRYPTION_KEY;
  if (env.ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes base64-encoded');
    }
  } else if (nodeEnv === 'production') {
    throw new Error('ENCRYPTION_KEY is required in production');
  }

  // Each social provider is enabled only when both its id and secret are set.
  const oauth: OAuthConfig = {
    google: oauthCreds(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: oauthCreds(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  };

  // When set, the SES delivery-event webhook rejects SNS messages from any
  // other topic. Unset in dev and CI, where the topic does not exist.
  const sesSnsTopicArn = env.SES_SNS_TOPIC_ARN || undefined;

  const sentryDsn = env.SENTRY_DSN || undefined;
  const adminEmail = env.ADMIN_EMAIL || undefined;
  const rateLimitEnabled = env.DISABLE_RATE_LIMIT !== 'true';

  // Tracing is off unless an exporter is chosen: the OTLP endpoint follows the
  // OpenTelemetry env convention, and the console exporter is a local switch.
  const tracing: TracingConfig = {
    consoleExporter: env.OTEL_TRACES_CONSOLE === 'true',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  };

  return {
    nodeEnv,
    port,
    logLevel,
    databaseUrl,
    appOrigin,
    smtp,
    tracing,
    encryptionKey,
    oauth,
    sesSnsTopicArn,
    stripeSecretKey,
    stripeWebhookSecret,
    stripePublishableKey,
    sentryDsn,
    adminEmail,
    rateLimitEnabled,
  };
}
