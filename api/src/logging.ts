import { AsyncLocalStorage } from 'node:async_hooks';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { LoggerOptions } from 'pino';
import type { Config } from './config.js';

export interface RequestContext {
  requestId: string;
}

// Carries the request id to log lines emitted outside req.log (db helpers,
// mailers, jobs) without threading it through every signature. The mixin
// below injects it as req_id on every line written inside a request.
export const requestContext = new AsyncLocalStorage<RequestContext>();

// Typed as pino options rather than Fastify's logger union, so the one-off jobs
// can build the same logger (base fields, redaction, trace ids) with pino()
// directly; Fastify accepts the same object.
export function loggerOptions(config: Config): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: 'authledger-api', env: config.nodeEnv },
    mixin() {
      const ctx = requestContext.getStore();
      const base = ctx ? { req_id: ctx.requestId } : {};
      // When tracing is on, tie the line to its span so logs and traces join on
      // trace_id. getActiveSpan is undefined when tracing is off, so this is a
      // no-op then.
      const span = trace.getActiveSpan();
      if (span) {
        const sc = span.spanContext();
        if (isSpanContextValid(sc)) {
          return { ...base, trace_id: sc.traceId, span_id: sc.spanId };
        }
      }
      return base;
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
}
