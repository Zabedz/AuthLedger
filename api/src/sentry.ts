import { isSpanContextValid, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';

// The single source of the "is error tracking on" decision, so the SDK bootstrap
// and the request-hook registration in server.ts cannot drift apart.
export function sentryEnabled(config: Config): boolean {
  return config.sentryDsn !== undefined;
}

// Sentry does error tracking only. Traces go to the OpenTelemetry provider
// (tracing.ts) and on to the collector, so Sentry's own tracing is off
// (tracesSampleRate 0) and skipOpenTelemetrySetup keeps it from registering a
// second, competing tracer provider. Reporting is off unless a DSN is set.
export function startSentry(config: Config): boolean {
  if (!sentryEnabled(config)) {
    return false;
  }
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    // No request headers, cookies, or client IP on events, the same discipline
    // the log redaction follows.
    sendDefaultPii: false,
    // Error tracking only: drop the default auto-instrumentation so Sentry never
    // patches modules or opens spans (traces are the OpenTelemetry provider's
    // job), and keep just the integrations that shape an error event. The
    // unhandled-rejection handler runs in strict mode so a stray rejection still
    // crashes the process (Node's default) after the event is captured.
    defaultIntegrations: false,
    integrations: [
      Sentry.inboundFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
    beforeSend(event) {
      // Tie the error to its trace, so a Sentry issue links to the collector's
      // trace on trace_id. No active span means tracing is off; leave it.
      const span = trace.getActiveSpan();
      if (span) {
        const sc = span.spanContext();
        if (isSpanContextValid(sc)) {
          event.contexts = {
            ...event.contexts,
            trace: { trace_id: sc.traceId, span_id: sc.spanId },
          };
        }
      }
      return event;
    },
  });
  return true;
}

// Reports a server-side failure with only the method and route template (no
// headers, query, or body), so nothing sensitive leaves in an event. A no-op
// when Sentry was never initialized, so it is safe to call unconditionally. Use
// it at a catch site that returns a 5xx instead of throwing, since onError only
// fires for a thrown or rejected error, not a returned reply.
export function reportServerError(error: unknown, request: FastifyRequest): void {
  Sentry.captureException(error, {
    contexts: {
      request: { method: request.method, url: request.routeOptions.url ?? 'unmatched' },
    },
  });
}

// Reports a failure from a one-off job (a scheduled task, not a request), tagged
// by job name. A no-op when Sentry was never initialized.
export function reportJobFailure(error: unknown, job: string): void {
  Sentry.captureException(error, { tags: { job } });
}

export async function stopSentry(): Promise<void> {
  // Flushes pending events within the timeout, then disables the client. A no-op
  // when Sentry was never initialized.
  await Sentry.close(2000);
}
