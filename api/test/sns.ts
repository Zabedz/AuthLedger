import { createSign, generateKeyPairSync } from 'node:crypto';
import type { SnsMessage } from '../src/domain/sns.js';

// A throwaway RSA keypair standing in for AWS's SNS signing cert. The public
// key PEM is what the stubbed cert fetcher returns; createVerify accepts a
// public key PEM the same as an X.509 certificate.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const signingCertPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

export const stubCertFetcher = async (): Promise<string> => signingCertPem;

function canonical(message: SnsMessage): string {
  const parts: string[] = [];
  const add = (k: string, v?: string) => {
    if (v !== undefined) parts.push(k, v);
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

export function signSnsMessage(
  partial: Omit<SnsMessage, 'Signature' | 'SignatureVersion'>,
): SnsMessage {
  const message = { ...partial, SignatureVersion: '1' } as SnsMessage;
  const signature = createSign('RSA-SHA256')
    .update(canonical(message), 'utf8')
    .sign(privateKey, 'base64');
  // SignatureVersion 2 selects RSA-SHA256 in the verifier, matching the sign.
  return { ...message, SignatureVersion: '2', Signature: signature };
}

const TOPIC = 'arn:aws:sns:us-west-2:111122223333:authledger-ses';
const CERT_URL = 'https://sns.us-west-2.amazonaws.com/cert.pem';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `msg-${counter}`;
}

export function bounceMessage(address: string, messageId = nextId()): SnsMessage {
  return signSnsMessage({
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: TOPIC,
    Timestamp: '2026-07-13T00:00:00.000Z',
    SigningCertURL: CERT_URL,
    Message: JSON.stringify({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: address }] },
    }),
  });
}

export function complaintMessage(address: string, messageId = nextId()): SnsMessage {
  return signSnsMessage({
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: TOPIC,
    Timestamp: '2026-07-13T00:00:00.000Z',
    SigningCertURL: CERT_URL,
    Message: JSON.stringify({
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: address }] },
    }),
  });
}

export function subscriptionConfirmation(subscribeUrl: string): SnsMessage {
  return signSnsMessage({
    Type: 'SubscriptionConfirmation',
    MessageId: nextId(),
    TopicArn: TOPIC,
    Timestamp: '2026-07-13T00:00:00.000Z',
    SigningCertURL: CERT_URL,
    Token: 'confirm-token',
    SubscribeURL: subscribeUrl,
    Message: 'You have chosen to subscribe.',
  });
}

export const expectedTopicArn = TOPIC;
