import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { DB } from '../db/types.js';
import type { EmailEnqueuer } from '../domain/dispatch.js';
import type { User } from '../domain/sessions.js';

export interface RouteDeps {
  config: Config;
  db: Kysely<DB>;
  enqueue: EmailEnqueuer;
}

export function userReply(user: User) {
  return {
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.email_verified_at !== null,
      created_at: user.created_at.toISOString(),
    },
  };
}

export function requestContextOf(req: { ip: string; headers: Record<string, unknown> }) {
  return {
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}
