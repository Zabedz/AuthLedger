import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  errorReplySchema,
  mfaCodeSchema,
  mfaSetupReplySchema,
  recoveryCodesSchema,
  totpCodeSchema,
} from '@authledger/shared';
import { recordAudit } from '../domain/audit.js';
import {
  consumeRecoveryCode,
  disableTotp,
  enableTotp,
  newTotpSecret,
  stageTotpSecret,
  totpUri,
  verifyTotpForUser,
} from '../domain/mfa.js';
import { requireAuth } from '../plugins/session-auth.js';
import { requestContextOf, type RouteDeps } from './deps.js';

export const mfaRoutes: FastifyPluginAsyncTypebox<RouteDeps> = async (
  app,
  { config, db, enqueue },
) => {
  const notify = (kind: 'mfa_enabled' | 'mfa_disabled', email: string, userId: string) =>
    enqueue.enqueue({ kind, recipient: email, userId, ctx: { appOrigin: config.appOrigin } });
  // Stage a fresh secret and hand back the otpauth URI for the authenticator
  // app. Not enabled until a code confirms it.
  app.post(
    '/setup',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { response: { 200: mfaSetupReplySchema, 409: errorReplySchema } },
    },
    async (req, reply) => {
      const { user } = req.auth!;
      if (user.totp_enabled_at !== null) {
        return reply.code(409).send({ error: 'MFA is already enabled' });
      }
      const secret = newTotpSecret();
      await stageTotpSecret(db, user.id, secret, config.encryptionKey);
      return reply.code(200).send({ secret, otpauth_uri: totpUri(secret, user.email) });
    },
  );

  // Confirm the staged secret with a code and turn MFA on, returning the
  // recovery codes once.
  app.post(
    '/enable',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: totpCodeSchema,
        response: { 200: recoveryCodesSchema, 400: errorReplySchema },
      },
    },
    async (req, reply) => {
      const { user } = req.auth!;
      if (user.totp_enabled_at !== null) {
        return reply.code(400).send({ error: 'MFA is already enabled' });
      }
      const result = await enableTotp(db, user.id, req.body.code, config.encryptionKey);
      if (!result) {
        return reply.code(400).send({ error: 'invalid code' });
      }
      await recordAudit(db, { event: 'mfa_enabled', userId: user.id, ...requestContextOf(req) });
      await notify('mfa_enabled', user.email, user.id);
      return reply.code(200).send({ recovery_codes: result.recoveryCodes });
    },
  );

  // Disabling requires a current TOTP or a recovery code, so a walk-up at an
  // unlocked session cannot silently remove the second factor, while a user
  // who lost their authenticator can still turn it off with a recovery code.
  app.post(
    '/disable',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: mfaCodeSchema, response: { 204: Type.Null(), 400: errorReplySchema } },
    },
    async (req, reply) => {
      const { user } = req.auth!;
      if (user.totp_enabled_at === null) {
        return reply.code(400).send({ error: 'MFA is not enabled' });
      }
      const code = req.body.code;
      const ok = /^[0-9]{6}$/.test(code)
        ? await verifyTotpForUser(db, user.id, code, config.encryptionKey)
        : await consumeRecoveryCode(db, user.id, code);
      if (!ok) {
        return reply.code(400).send({ error: 'invalid code' });
      }
      await disableTotp(db, user.id);
      await recordAudit(db, { event: 'mfa_disabled', userId: user.id, ...requestContextOf(req) });
      await notify('mfa_disabled', user.email, user.id);
      return reply.code(204).send(null);
    },
  );
};
