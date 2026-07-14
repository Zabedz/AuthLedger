import { context, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    otelSpan?: Span;
  }
}

const tracer = trace.getTracer('authledger-http');

// Opens a server span per request and makes it the active context for the rest
// of the request, so spans created deeper (a ledger posting) attach as children
// and the log mixin can read the trace id. Wrapping the Fastify continuation in
// context.with keeps the span active across the whole async request, the same
// way the request-id AsyncLocalStorage does; register this after that hook so
// the two wrappers nest around the same continuation.
export function registerHttpTracing(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    // The raw url can carry a query string and is high-cardinality; the response
    // hook renames the span to the matched route template.
    const span = tracer.startSpan(`${req.method} ${req.url}`, {
      kind: SpanKind.SERVER,
      attributes: { [ATTR_HTTP_REQUEST_METHOD]: req.method },
    });
    req.otelSpan = span;
    context.with(trace.setSpan(context.active(), span), done);
  });

  app.addHook('onResponse', async (req, reply) => {
    const span = req.otelSpan;
    if (!span) {
      return;
    }
    req.otelSpan = undefined;
    // The matched route template keeps the name low-cardinality; an unmatched
    // request (a 404) has no template, so label it once instead of by raw path.
    const route = req.routeOptions.url;
    span.updateName(`${req.method} ${route ?? 'unmatched'}`);
    if (route) {
      span.setAttribute(ATTR_HTTP_ROUTE, route);
    }
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, reply.statusCode);
    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  });

  // A client that disconnects before the response never fires onResponse, so end
  // the span here or it leaks. Clearing it first makes a racing late onResponse a
  // no-op through the guard above, so the span is never ended twice.
  app.addHook('onRequestAbort', async (req) => {
    const span = req.otelSpan;
    if (!span) {
      return;
    }
    req.otelSpan = undefined;
    span.setAttribute('http.aborted', true);
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'client aborted' });
    span.end();
  });

  app.addHook('onError', async (req, _reply, err) => {
    req.otelSpan?.recordException(err);
    req.otelSpan?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  });
}
