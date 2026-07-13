import { PgBoss, type Job } from 'pg-boss';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import {
  deliverEmail,
  toDeliveryJob,
  type DeliveryJob,
  type EmailEnqueuer,
  type EmailRequest,
} from '../domain/dispatch.js';
import type { Mailer } from '../domain/mailer.js';
import { purgeExpired } from '../domain/purge.js';

const SEND_EMAIL = 'send-email';
const PURGE = 'purge-expired';

export interface JobLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface JobRunner extends EmailEnqueuer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// pg-boss owns retries and the schedule; the handlers are the same functions
// the tests exercise directly, so the queue adds delivery and timing, not
// logic.
export function createJobRunner(
  connectionString: string,
  db: Kysely<DB>,
  mailer: Mailer,
  log: JobLogger,
): JobRunner {
  const boss = new PgBoss({ connectionString });
  boss.on('error', (err: Error) => log.error({ err }, 'pg-boss error'));

  return {
    async start() {
      await boss.start();
      // The email payload carries a plaintext verify/reset token, so keep
      // completed and failed rows out of the queue tables briefly rather than
      // for pg-boss's multi-day default.
      await boss.createQueue(SEND_EMAIL, { retentionSeconds: 3600, deleteAfterSeconds: 300 });
      await boss.createQueue(PURGE);

      await boss.work<DeliveryJob>(
        SEND_EMAIL,
        { batchSize: 1 },
        async (jobs: Job<DeliveryJob>[]) => {
          for (const job of jobs) {
            const outcome = await deliverEmail(db, mailer, job.data);
            log.info({ kind: job.data.kind, outcome }, 'email job processed');
          }
        },
      );

      await boss.work(PURGE, { batchSize: 1 }, async () => {
        const counts = await purgeExpired(db);
        log.info(counts, 'purge job processed');
      });

      await boss.schedule(PURGE, '15 3 * * *');
    },

    async enqueue(request: EmailRequest) {
      await boss.send(SEND_EMAIL, toDeliveryJob(request), {
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
      });
    },

    async stop() {
      await boss.stop();
    },
  };
}
