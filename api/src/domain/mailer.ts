import { createTransport, type Transporter } from 'nodemailer';
import type { SmtpConfig } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export function createSmtpMailer(config: SmtpConfig, requireTls = false): Mailer {
  const secure = config.port === 465;
  const transport: Transporter = createTransport({
    host: config.host,
    port: config.port,
    // Mailpit and SES on 587 both start plaintext then STARTTLS; only 465 is
    // implicit TLS.
    secure,
    // In production, refuse to fall back to plaintext if STARTTLS is stripped.
    requireTLS: !secure && requireTls,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });

  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
