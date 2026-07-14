import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Config } from './config.js';

// The process tracer provider. The app emits spans by hand: one server span per
// request (plugins/tracing) and a child span around each ledger posting
// (domain/ledger). No library patching, so ESM needs no loader hook. When no
// exporter is configured the provider is never registered, and every span the
// app creates falls back to the API's no-op, so tracing stays off by default at
// no cost.
let provider: NodeTracerProvider | undefined;

// The single source of the "is tracing on" decision, so the SDK bootstrap here
// and the request-hook registration in server.ts cannot drift apart.
export function tracingEnabled(config: Config): boolean {
  return config.tracing.consoleExporter || config.tracing.otlpEndpoint !== undefined;
}

export function startTracing(config: Config): boolean {
  if (!tracingEnabled(config)) {
    return false;
  }
  const { consoleExporter, otlpEndpoint } = config.tracing;
  const processors: SpanProcessor[] = [];
  if (otlpEndpoint) {
    // No url passed: the exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and appends
    // the /v1/traces path per the OpenTelemetry spec.
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  if (consoleExporter) {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'authledger-api',
      'deployment.environment.name': config.nodeEnv,
    }),
    spanProcessors: processors,
  });
  provider.register();
  return true;
}

export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
}
