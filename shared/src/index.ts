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
