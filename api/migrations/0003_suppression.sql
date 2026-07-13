-- Addresses SES told us bounced or complained. Sending to them again would
-- hurt deliverability, so the mailer skips them.
CREATE TABLE email_suppressions (
  address citext PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Replay protection for SNS notifications: a message id seen before is a
-- redelivery and must not be processed twice. Rows age out with the purge job.
CREATE TABLE processed_sns_messages (
  message_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
