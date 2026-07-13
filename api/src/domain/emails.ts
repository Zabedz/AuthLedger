import type { EmailMessage } from './mailer.js';

export type EmailKind =
  | 'verify_email'
  | 'reset_password'
  | 'password_changed'
  | 'new_device_login'
  | 'account_locked'
  | 'account_deleted';

function verifyLink(appOrigin: string, token: string): string {
  return `${appOrigin}/verify-email?token=${encodeURIComponent(token)}`;
}

function resetLink(appOrigin: string, token: string): string {
  return `${appOrigin}/reset-password?token=${encodeURIComponent(token)}`;
}

export interface EmailContext {
  appOrigin: string;
  token?: string;
}

// Plain-text only for now; the transport and the flows do not depend on HTML,
// and a text body sidesteps a second templating path.
export function composeEmail(kind: EmailKind, to: string, ctx: EmailContext): EmailMessage {
  switch (kind) {
    case 'verify_email':
      return {
        to,
        subject: 'Verify your authledger email',
        text: `Confirm this address to finish setting up your account:\n\n${verifyLink(ctx.appOrigin, ctx.token!)}\n\nThe link expires in 24 hours. If you did not sign up, ignore this email.`,
      };
    case 'reset_password':
      return {
        to,
        subject: 'Reset your authledger password',
        text: `Reset your password with this link:\n\n${resetLink(ctx.appOrigin, ctx.token!)}\n\nThe link expires in 1 hour and can be used once. If you did not ask for a reset, ignore this email.`,
      };
    case 'password_changed':
      return {
        to,
        subject: 'Your authledger password changed',
        text: `Your password was just changed and all other sessions were signed out. If this was not you, reset your password immediately at ${ctx.appOrigin}.`,
      };
    case 'new_device_login':
      return {
        to,
        subject: 'New sign-in to your authledger account',
        text: `A new device signed in to your account. If this was not you, change your password at ${ctx.appOrigin}.`,
      };
    case 'account_locked':
      return {
        to,
        subject: 'Your authledger account was locked',
        text: `Too many failed sign-in attempts locked your account for a short time. If this was not you, reset your password once the lock clears at ${ctx.appOrigin}.`,
      };
    case 'account_deleted':
      return {
        to,
        subject: 'Your authledger account was deleted',
        text: `Your account and personal data have been removed. If you did not request this, contact support.`,
      };
  }
}
