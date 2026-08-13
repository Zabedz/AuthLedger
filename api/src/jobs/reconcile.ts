import { SpanStatusCode, trace } from '@opentelemetry/api';
import pino from 'pino';
import Stripe from 'stripe';
import { loadConfig } from '../config.js';
import { createDb, createPool } from '../db/client.js';
import { runAndRecordReconciliation } from '../domain/reconciliation.js';
import { loggerOptions } from '../logging.js';
import { reportJobFailure, startSentry, stopSentry } from '../sentry.js';
import { startTracing, stopTracing } from '../tracing.js';

// One-off scheduled reconciliation (EventBridge Scheduler runs this file via an
// ECS RunTask command override, the same pattern as the migrate task). It calls
// the same function the admin endpoint uses, so the outcome, success or failure,
// lands in the reconciliations run history either way; this file adds the
// process shape around it: structured logs, a root span, Sentry on failure, and
// an exit code the task state reflects.
const config = loadConfig();
startSentry(config);
startTracing(config);

const log = pino(loggerOptions(config));
const pool = createPool(config.databaseUrl);
const db = createDb(pool);
const tracer = trace.getTracer('authledger-jobs');

async function run(): Promise<number> {
  return tracer.startActiveSpan('reconciliation.scheduled_run', async (span) => {
    try {
      // Thrown, not returned, so a misconfigured schedule takes the same loud
      // path as any other failure: span error, log, Sentry.
      if (!config.stripeSecretKey) {
        throw new Error('STRIPE_SECRET_KEY is not set; reconciliation cannot run');
      }
      const stripe = new Stripe(config.stripeSecretKey);
      const outcome = await runAndRecordReconciliation(db, stripe);
      span.setAttribute('reconciliation.checked', outcome.checked);
      span.setAttribute('reconciliation.discrepancy_count', outcome.discrepancies.length);
      const summary = {
        run_id: outcome.id,
        checked: outcome.checked,
        fees_posted_minor: outcome.feesPostedMinor,
        discrepancy_count: outcome.discrepancies.length,
      };
      // A discrepancy is a finding for the admin view, not a job failure, but it
      // should stand out in the logs.
      if (outcome.discrepancies.length > 0) {
        log.warn(
          { ...summary, discrepancies: outcome.discrepancies },
          'reconciliation found discrepancies',
        );
      } else {
        log.info(summary, 'reconciliation run clean');
      }
      return 0;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      log.error({ err }, 'reconciliation run failed');
      reportJobFailure(err, 'reconcile');
      return 1;
    } finally {
      span.end();
    }
  });
}

const exitCode = await run();

// Cleanup must never overwrite the run's outcome: stopTracing rejects when the
// collector is unreachable at the final flush, and an unhandled rejection here
// would turn a clean run into exit 1. Log and move on.
for (const [name, step] of [
  ['pool.end', () => pool.end()],
  ['stopTracing', stopTracing],
  ['stopSentry', stopSentry],
] as const) {
  try {
    await step();
  } catch (err) {
    log.warn({ err }, `${name} failed during job shutdown`);
  }
}
process.exit(exitCode);
