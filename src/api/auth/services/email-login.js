'use strict';

const crypto = require('node:crypto');
const input = require('../../participation/participation-internal/input');
const problem = require('../../participation/participation-internal/problem');
const createRequests = require('../../participation/participation-internal/requests');
const emailValue = require('../join-identity-internal/contact-value');

module.exports = ({ strapi }) => {
  const identity = () => strapi.service('api::auth.join-identity');
  const requests = createRequests({ strapi });
  const pending = new Set();
  function deliver(id) {
    const work = new Promise(resolve => setImmediate(resolve)).then(() => identity().deliverEmailProof(id)).catch(() => { strapi.log.error('[email-login] verification delivery failed'); });
    pending.add(work);
    work.then(() => { pending.delete(work); });
  }
  return {
    async request(body, socketPeer) {
      input.body(body, ['requestId', 'emailRaw', 'browserSecret']); input.browser(body.browserSecret);
      try { emailValue(body.emailRaw); } catch { problem('VALIDATION_ERROR', 422, { emailRaw: 'Enter a valid email address.' }); }
      const result = await identity().withTransaction(trx => identity().requestEmailProof(trx, {
        purpose: 'email_login', rawValue: body.emailRaw, browserSecret: body.browserSecret, requestId: body.requestId, socketPeer,
      }));
      if (result.kind === 'rejected') {
        return { kind: 'pending_verification', proofId: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 600000).toISOString(), resendAfterSeconds: 60 };
      }
      deliver(result.delivery.requestReceiptId);
      return { kind: 'pending_verification', proofId: result.public.proofId, expiresAt: result.public.expiresAt, resendAfterSeconds: 60 };
    },
    async verify(body) {
      input.body(body, ['requestId', 'proofId', 'browserSecret', 'code']); input.browser(body.browserSecret); input.receiptId(body.proofId);
      if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) problem('INVALID_PROOF', 400);
      const actorId = await identity().withTransaction(async trx => {
        const descriptor = identity().describeEmailLoginVerification(trx, body);
        if (await requests.find(trx, descriptor)) return null;
        const proofs = strapi.db.metadata.get('api::participation.contact-proof').tableName;
        const before = await trx(proofs).where({ receipt_id: body.proofId, browser_secret_hash: descriptor.browserKey, purpose: 'email_login' }).first();
        if (!before) return null;
        const verified = await identity().consumeEmailProof(trx, { ...body, purpose: 'email_login' });
        if (verified.kind !== 'verified') {
          const current = await trx(proofs).select('attempts').where({ id: before.id }).first();
          if (current && current.attempts > before.attempts) await requests.save(descriptor, { kind: 'invalid_proof' });
          return null;
        }
        await requests.save(descriptor, { kind: 'email_login_verified' });
        return verified.proof.actorId;
      });
      if (!actorId) problem('INVALID_PROOF', 400);
      return actorId;
    },
    async drain() { await Promise.all([...pending]); },
  };
};
