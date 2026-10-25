'use strict';

const crypto = require('node:crypto');
const emailValue = require('./contact-value');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

module.exports = ({ strapi, databaseNow }) => {
  const table = name => strapi.db.metadata.get('api::participation.' + name).tableName;
  const users = () => strapi.db.metadata.get('plugin::users-permissions.user').tableName;
  const lock = query => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') query.forUpdate();
    return query;
  };
  async function activeUser(trx, id) {
    const user = await lock(trx(users()).where({ id })).first();
    if (!user || user.blocked) fail('IDENTITY_ACCOUNT_UNAVAILABLE');
    return user;
  }
  async function currentMapping(trx, proof) {
    return trx(table('verified-contact')).where({ channel: 'email', destination_key: proof.destination_key, revoked_at: null }).first();
  }
  async function legacyCandidate(trx, proof) {
    const matches = [];
    let cursor = 0;
    while (true) {
      const rows = await lock(trx(users()).select('id', 'email', 'blocked').where('id', '>', cursor).orderBy('id').limit(200));
      for (const row of rows) {
        if (typeof row.email !== 'string') continue;
        let email;
        try { email = emailValue(row.email); } catch { continue; }
        if (email.deliveryValue.toLowerCase() === proof.delivery_value.toLowerCase()) matches.push({ ...row, deliveryValue: email.deliveryValue });
      }
      if (rows.length < 200) break;
      cursor = rows[rows.length - 1].id;
    }
    if (matches.length > 1 || (matches.length === 1 && matches[0].deliveryValue !== proof.delivery_value)) fail('IDENTITY_COLLISION');
    if (!matches.length) return null;
    if (matches[0].blocked) fail('IDENTITY_ACCOUNT_UNAVAILABLE');
    return matches[0];
  }
  async function bind(trx, proof, intent, user, mapping, created) {
    if (!mapping) {
      mapping = await strapi.db.query('api::participation.verified-contact').create({ data: {
        channel: 'email', derivationVersion: proof.derivation_version, destinationKey: proof.destination_key,
        userId: user.id, proofId: proof.id, verifiedAt: new Date().toISOString(),
      } });
    } else {
      mapping = await lock(trx(table('verified-contact')).where({ id: mapping.id, user_id: user.id, channel: 'email', destination_key: proof.destination_key, derivation_version: proof.derivation_version, revoked_at: null })).first();
      if (!mapping) fail('IDENTITY_ACCOUNT_CHANGED');
    }
    const changed = await trx(table('join-intent')).where({ id: intent.id, state: intent.state }).where('expires_at', '>', databaseNow(trx)).update({ bound_actor_id: user.id, state: 'pending', updated_at: new Date() });
    if (changed !== 1) fail('IDENTITY_SCOPE_UNAVAILABLE');
    const newsletter = strapi.service('api::newsletter.newsletter');
    const status = await newsletter.ensureAccountSubscription({ userId: user.id, verifiedContactId: mapping.id, disclosureVersion: newsletter.disclosure.version });
    const live = await trx(table('join-intent')).select('id').where({ id: intent.id, bound_actor_id: user.id, state: 'pending' }).where('expires_at', '>', databaseNow(trx)).first();
    if (!live) fail('IDENTITY_SCOPE_UNAVAILABLE');
    return { kind: 'account', userId: user.id, verifiedContactId: mapping.id, created, newsletter: status.state };
  }
  return {
    async fresh(trx, proof, intent) {
      const mapping = await currentMapping(trx, proof);
      if (mapping) {
        if (intent.bound_actor_id !== null && intent.bound_actor_id !== mapping.user_id) fail('IDENTITY_ACCOUNT_CHANGED');
        const user = await activeUser(trx, mapping.user_id);
        return bind(trx, proof, intent, user, mapping, false);
      }
      const legacy = await legacyCandidate(trx, proof);
      if (legacy && intent.bound_actor_id !== null && legacy.id !== intent.bound_actor_id) fail('IDENTITY_ACCOUNT_CHANGED');
      if (legacy && intent.bound_actor_id === null) {
        const changed = await trx(table('join-intent')).where({ id: intent.id, state: 'pending' }).where('expires_at', '>', databaseNow(trx)).update({ bound_legacy_user_id: legacy.id, state: 'sign_in_required', updated_at: new Date() });
        if (changed !== 1) fail('IDENTITY_SCOPE_UNAVAILABLE');
        return { kind: 'sign_in_required' };
      }
      if (intent.bound_actor_id !== null) return bind(trx, proof, intent, await activeUser(trx, intent.bound_actor_id), null, false);
      const roles = await strapi.db.query('plugin::users-permissions.role').findMany({ where: { type: 'authenticated' } });
      if (roles.length !== 1) fail('IDENTITY_ROLE_UNAVAILABLE');
      const user = await strapi.plugin('users-permissions').service('user').add({
        username: 'garden_' + crypto.randomBytes(24).toString('hex'), password: crypto.randomBytes(48).toString('base64url'),
        provider: 'local', email: proof.delivery_value, confirmed: true, blocked: false, role: roles[0].id,
      });
      return bind(trx, proof, intent, user, null, true);
    },
    async resume(trx, { intentId, actorId, browserKey }) {
      const intent = await lock(trx(table('join-intent')).where({ id: intentId, state: 'sign_in_required', browser_secret_hash: browserKey, bound_legacy_user_id: actorId }).where('expires_at', '>', databaseNow(trx))).first();
      if (!intent) fail('IDENTITY_ACCOUNT_CHANGED');
      const proofs = await lock(trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity', browser_secret_hash: browserKey, superseded_at: null }).whereNotNull('consumed_at').limit(2));
      if (proofs.length !== 1) fail('IDENTITY_PROOF_UNAVAILABLE');
      const proof = proofs[0];
      const mapping = await currentMapping(trx, proof);
      if (mapping && mapping.user_id !== actorId) fail('IDENTITY_ACCOUNT_CHANGED');
      const legacy = await legacyCandidate(trx, proof);
      if (legacy && legacy.id !== actorId) fail('IDENTITY_ACCOUNT_CHANGED');
      return bind(trx, proof, intent, await activeUser(trx, actorId), mapping, false);
    },
  };
};
