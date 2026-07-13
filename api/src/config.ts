const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  stripeSecretKey: string | undefined;
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

  const stripeSecretKey = env.STRIPE_SECRET_KEY || undefined;
  if (stripeSecretKey && nodeEnv !== 'production' && !stripeSecretKey.startsWith('sk_test_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must be a test-mode key (sk_test_...) outside production; ` +
        `got a key starting with "${stripeSecretKey.slice(0, 3)}..."`,
    );
  }

  return { nodeEnv, port, logLevel, databaseUrl, stripeSecretKey };
}
