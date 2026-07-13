import Fastify, { type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { createDb, createPool } from '../src/db/client.js';
import type { DB } from '../src/db/types.js';
import { isSuppressed } from '../src/domain/suppression.js';
import { webhookRoutes } from '../src/routes/webhooks.js';
import { testConfig, truncateAll } from './helpers.js';
import { testDatabaseUrl } from './test-db.js';
import {
  bounceMessage,
  complaintMessage,
  expectedTopicArn,
  signSnsMessage,
  stubCertFetcher,
  subscriptionConfirmation,
} from './sns.js';

const pool = createPool(testDatabaseUrl());
const db: Kysely<DB> = createDb(pool);

let app: FastifyInstance;
let confirmed: string[];

function buildWebhookApp(topicArn?: string): FastifyInstance {
  confirmed = [];
  const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  void instance.register(webhookRoutes, {
    prefix: '/api/webhooks',
    config: { ...testConfig, sesSnsTopicArn: topicArn },
    db,
    fetchCert: stubCertFetcher,
    confirmSubscription: async (url) => {
      confirmed.push(url);
    },
  });
  return instance;
}

function post(message: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/ses-notifications',
    headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify(message),
  });
}

async function auditKinds() {
  const rows = await db.selectFrom('audit_events').select('event').execute();
  return rows.map((r) => r.event);
}

beforeEach(async () => {
  await truncateAll(db);
  app = buildWebhookApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('SES delivery-event webhook', () => {
  it('suppresses a bounced address and audits it', async () => {
    const res = await post(bounceMessage('bounced@example.com'));
    expect(res.statusCode).toBe(200);
    expect(await isSuppressed(db, 'bounced@example.com')).toBe(true);
    expect(await auditKinds()).toContain('email_bounced');
  });

  it('suppresses a complaint and audits it', async () => {
    const res = await post(complaintMessage('angry@example.com'));
    expect(res.statusCode).toBe(200);
    expect(await isSuppressed(db, 'angry@example.com')).toBe(true);
    expect(await auditKinds()).toContain('email_complained');
  });

  it('rejects a tampered message with 403 and suppresses nothing', async () => {
    const message = bounceMessage('victim@example.com');
    message.Message = JSON.stringify({
      notificationType: 'Bounce',
      bounce: { bouncedRecipients: [{ emailAddress: 'attacker-target@example.com' }] },
    });

    const res = await post(message);
    expect(res.statusCode).toBe(403);
    expect(await isSuppressed(db, 'attacker-target@example.com')).toBe(false);
  });

  it('is idempotent: a redelivered message id suppresses once', async () => {
    const message = bounceMessage('twice@example.com', 'stable-id');
    await post(message);
    await post(message);

    const audits = (await auditKinds()).filter((e) => e === 'email_bounced');
    expect(audits).toHaveLength(1);
  });

  it('treats a non-JSON Message as a no-op and does not poison the dedup table', async () => {
    const message = bounceMessage('later@example.com', 'reused-id');
    message.Message = 'not json at all';
    // Re-sign so the tampered Message still verifies.
    const signed = signSnsMessage({
      Type: message.Type,
      MessageId: message.MessageId,
      TopicArn: message.TopicArn,
      Timestamp: message.Timestamp,
      SigningCertURL: message.SigningCertURL,
      Message: message.Message,
    });

    const res = await post(signed);
    expect(res.statusCode).toBe(200);
    const rows = await db.selectFrom('processed_sns_messages').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('confirms a subscription by fetching its SubscribeURL', async () => {
    const res = await post(
      subscriptionConfirmation('https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription'),
    );
    expect(res.statusCode).toBe(200);
    expect(confirmed).toEqual(['https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription']);
  });

  it('rejects a message from an unexpected topic when a topic is pinned', async () => {
    await app.close();
    app = buildWebhookApp('arn:aws:sns:us-west-2:111122223333:some-other-topic');
    await app.ready();

    const res = await post(bounceMessage('x@example.com'));
    expect(res.statusCode).toBe(403);
    expect(await isSuppressed(db, 'x@example.com')).toBe(false);
  });

  it('accepts a message from the pinned topic', async () => {
    await app.close();
    app = buildWebhookApp(expectedTopicArn);
    await app.ready();

    const res = await post(bounceMessage('ok@example.com'));
    expect(res.statusCode).toBe(200);
    expect(await isSuppressed(db, 'ok@example.com')).toBe(true);
  });
});

describe('production route gate', () => {
  it('does not register the webhook in production without a pinned topic', async () => {
    const { makeTestServer } = await import('./helpers.js');
    const ctx = await makeTestServer({
      config: {
        nodeEnv: 'production',
        appOrigin: 'https://app.example',
        sesSnsTopicArn: undefined,
      },
    });
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/webhooks/ses-notifications',
        // Matching origin so the CSRF gate passes and the 404 (route not
        // registered) surfaces rather than a 403 from the origin check.
        headers: { 'content-type': 'text/plain', origin: 'https://app.example' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });
});

describe('the default cert fetcher rejects untrusted URLs', () => {
  it('refuses a non-amazonaws SigningCertURL', async () => {
    const { fetchSigningCert } = await import('../src/domain/sns.js');
    await expect(fetchSigningCert('https://evil.example/cert.pem')).rejects.toThrow(/untrusted/);
  });

  it('refuses a look-alike host', async () => {
    const { fetchSigningCert } = await import('../src/domain/sns.js');
    await expect(
      fetchSigningCert('https://sns.us-west-2.amazonaws.com.evil.example/cert.pem'),
    ).rejects.toThrow(/untrusted/);
  });
});

describe('suppression blocks future sends', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a suppressed recipient is not delivered', async () => {
    const { deliverEmail } = await import('../src/domain/dispatch.js');
    await post(bounceMessage('blocked@example.com'));

    const mailer = { send: vi.fn(async () => {}) };
    const outcome = await deliverEmail(db, mailer, {
      dedupeKey: 'k1',
      kind: 'verify_email',
      recipient: 'blocked@example.com',
      userId: null,
      message: { to: 'blocked@example.com', subject: 's', text: 't' },
    });

    expect(outcome).toBe('skipped_suppressed');
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
