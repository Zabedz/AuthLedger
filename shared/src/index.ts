import { Type, type Static } from '@sinclair/typebox';

export const healthzReplySchema = Type.Object({
  status: Type.Literal('ok'),
  uptime_s: Type.Number(),
});
export type HealthzReply = Static<typeof healthzReplySchema>;

export const readyCheckSchema = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});
export type ReadyCheck = Static<typeof readyCheckSchema>;

export const readyzReplySchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('unavailable')]),
  checks: Type.Array(readyCheckSchema),
});
export type ReadyzReply = Static<typeof readyzReplySchema>;

export const credentialsSchema = Type.Object({
  email: Type.String({ format: 'email', maxLength: 254 }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});
export type Credentials = Static<typeof credentialsSchema>;

export const userSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  created_at: Type.String(),
});
export type UserReply = Static<typeof userSchema>;

export const userEnvelopeSchema = Type.Object({ user: userSchema });
export type UserEnvelope = Static<typeof userEnvelopeSchema>;

export const errorReplySchema = Type.Object({ error: Type.String() });
export type ErrorReply = Static<typeof errorReplySchema>;

export const sessionItemSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  created_at: Type.String(),
  last_seen_at: Type.String(),
  ip: Type.Union([Type.String(), Type.Null()]),
  user_agent: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});
export type SessionItem = Static<typeof sessionItemSchema>;

export const sessionListSchema = Type.Object({ sessions: Type.Array(sessionItemSchema) });
export type SessionList = Static<typeof sessionListSchema>;
