import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { errorReplySchema } from '@authledger/shared';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import { recordAudit } from '../domain/audit.js';
import {
  confirmSubscription as defaultConfirmSubscription,
  fetchSigningCert,
  verifySnsMessage,
  type CertFetcher,
  type SnsMessage,
} from '../domain/sns.js';
import { suppressAddress } from '../domain/suppression.js';

export interface WebhookDeps {
  config: Config;
  db: Kysely<DB>;
  fetchCert?: CertFetcher;
  // Confirming a subscription means fetching its one-time SubscribeURL; kept
  // injectable so tests do not reach the network.
  confirmSubscription?: (url: string) => Promise<void>;
}

interface SesEvent {
  notificationType?: string;
  bounce?: { bouncedRecipients?: { emailAddress: string }[]; bounceType?: string };
  complaint?: { complainedRecipients?: { emailAddress: string }[] };
}

export const webhookRoutes: FastifyPluginAsyncTypebox<WebhookDeps> = async (app, deps) => {
  const { config, db } = deps;
  const fetchCert = deps.fetchCert ?? fetchSigningCert;
  const confirmSubscription = deps.confirmSubscription ?? defaultConfirmSubscription;

  // SNS posts JSON under a text/plain content type, so the default JSON parser
  // never runs. This parser is scoped to the webhooks plugin.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post(
    '/ses-notifications',
    {
      // Authenticated by SNS signature, not a session cookie.
      config: {
        policy: 'public',
        skipOriginCheck: true,
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
      schema: { response: { 200: Type.Null(), 403: errorReplySchema } },
    },
    async (req, reply) => {
      const message = req.body as SnsMessage;
      const rejected = { error: 'rejected' };

      // Topic first: a cheap string compare drops spam not claiming our topic
      // before the outbound cert fetch that verification needs.
      if (config.sesSnsTopicArn && message.TopicArn !== config.sesSnsTopicArn) {
        req.log.warn({ topic: message.TopicArn }, 'SNS message from an unexpected topic');
        return reply.code(403).send(rejected);
      }

      let valid = false;
      try {
        valid = await verifySnsMessage(message, fetchCert);
      } catch (err) {
        req.log.warn({ err }, 'SNS signature verification errored');
      }
      if (!valid) {
        return reply.code(403).send(rejected);
      }

      if (message.Type === 'SubscriptionConfirmation') {
        if (message.SubscribeURL) {
          await confirmSubscription(message.SubscribeURL);
        }
        return reply.code(200).send(null);
      }

      if (message.Type !== 'Notification') {
        return reply.code(200).send(null);
      }

      // Parse before claiming so a non-JSON Message (an operator test publish)
      // is a logged no-op, not a poisoned dedup row that blocks a later event.
      let event: SesEvent;
      try {
        event = JSON.parse(message.Message) as SesEvent;
      } catch {
        req.log.warn({ messageId: message.MessageId }, 'SNS Message is not JSON');
        return reply.code(200).send(null);
      }

      // Claim and process atomically: a failure rolls the claim back so the
      // SNS redelivery reprocesses.
      await db.transaction().execute(async (trx) => {
        const claim = await trx
          .insertInto('processed_sns_messages')
          .values({ message_id: message.MessageId })
          .onConflict((oc) => oc.column('message_id').doNothing())
          .returning('message_id')
          .executeTakeFirst();
        if (!claim) {
          return;
        }

        if (event.notificationType === 'Bounce') {
          for (const r of event.bounce?.bouncedRecipients ?? []) {
            await suppressAddress(trx, r.emailAddress, 'bounce', {
              bounceType: event.bounce?.bounceType,
              sns_message_id: message.MessageId,
            });
            await recordAudit(trx, {
              event: 'email_bounced',
              detail: { address: r.emailAddress, bounceType: event.bounce?.bounceType },
            });
          }
        } else if (event.notificationType === 'Complaint') {
          for (const r of event.complaint?.complainedRecipients ?? []) {
            await suppressAddress(trx, r.emailAddress, 'complaint', {
              sns_message_id: message.MessageId,
            });
            await recordAudit(trx, {
              event: 'email_complained',
              detail: { address: r.emailAddress },
            });
          }
        }
      });

      return reply.code(200).send(null);
    },
  );
};
