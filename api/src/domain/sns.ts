import { createVerify } from 'node:crypto';

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

// Fetches the PEM certificate for a SigningCertURL. Rejects any host that is
// not an AWS SNS endpoint, since the URL is attacker-controlled input and a
// forged cert from an arbitrary host would defeat the whole check.
export type CertFetcher = (url: string) => Promise<string>;

// Both the signing-cert URL and the subscription-confirmation URL are
// attacker-controlled fields, so both are checked against this one allowlist.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

const FETCH_TIMEOUT_MS = 5000;

function assertSnsUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !SNS_HOST.test(parsed.hostname)) {
    throw new Error(`refusing to reach an untrusted SNS URL: ${url}`);
  }
}

// AWS rotates SNS signing certs infrequently, so cache by URL to avoid an
// outbound fetch per message under bounce volume.
const certCache = new Map<string, string>();

export const fetchSigningCert: CertFetcher = async (url) => {
  assertSnsUrl(url);
  const cached = certCache.get(url);
  if (cached) {
    return cached;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`SNS cert fetch failed: ${res.status}`);
  }
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

// Confirming a subscription is a one-time GET of the SubscribeURL SNS sends.
export async function confirmSubscription(url: string): Promise<void> {
  assertSnsUrl(url);
  await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// The exact fields and order SNS signs, which differ by message type.
function canonicalString(message: SnsMessage): string {
  const parts: string[] = [];
  const add = (key: string, value?: string) => {
    if (value !== undefined) {
      parts.push(key, value);
    }
  };

  if (message.Type === 'Notification') {
    add('Message', message.Message);
    add('MessageId', message.MessageId);
    add('Subject', message.Subject);
    add('Timestamp', message.Timestamp);
    add('TopicArn', message.TopicArn);
    add('Type', message.Type);
  } else {
    add('Message', message.Message);
    add('MessageId', message.MessageId);
    add('SubscribeURL', message.SubscribeURL);
    add('Timestamp', message.Timestamp);
    add('Token', message.Token);
    add('TopicArn', message.TopicArn);
    add('Type', message.Type);
  }

  return parts.join('\n') + '\n';
}

export async function verifySnsMessage(
  message: SnsMessage,
  fetchCert: CertFetcher = fetchSigningCert,
): Promise<boolean> {
  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  const cert = await fetchCert(message.SigningCertURL);

  return createVerify(algorithm)
    .update(canonicalString(message), 'utf8')
    .verify(cert, message.Signature, 'base64');
}
