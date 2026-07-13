import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmtpMailer } from '../src/domain/mailer.js';
import { composeEmail } from '../src/domain/emails.js';

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);

interface MailpitMessage {
  ID: string;
  Subject: string;
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_API}/api/v1/info`);
    return res.ok;
  } catch {
    return false;
  }
}

// Proves the real SMTP transport and that a delivered verification email
// carries a usable link, which the capturing mailer in the flow tests cannot.
describe('SMTP delivery through Mailpit', () => {
  let available = false;

  beforeAll(async () => {
    available = await mailpitReachable();
    if (available) {
      await fetch(`${MAILPIT_API}/api/v1/messages`, { method: 'DELETE' });
    }
  });

  afterAll(async () => {
    if (available) {
      await fetch(`${MAILPIT_API}/api/v1/messages`, { method: 'DELETE' });
    }
  });

  it('delivers a verification email whose link contains the token', async ({ skip }) => {
    if (!available) {
      skip();
      return;
    }

    const mailer = createSmtpMailer({
      host: 'localhost',
      port: SMTP_PORT,
      user: undefined,
      pass: undefined,
      from: 'authledger <no-reply@authledger.test>',
    });

    const recipient = `mailpit-${process.hrtime.bigint()}@example.com`;
    const token = 'the-token-value';
    await mailer.send(
      composeEmail('verify_email', recipient, {
        appOrigin: 'http://localhost:5173',
        token,
      }),
    );

    const list = (await (await fetch(`${MAILPIT_API}/api/v1/messages`)).json()) as {
      messages: MailpitMessage[];
    };
    const message = list.messages.find((m) => m.Subject.match(/verify/i));
    expect(message, 'the verification email arrived at Mailpit').toBeDefined();

    const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${message!.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain(`token=${token}`);
  });
});
