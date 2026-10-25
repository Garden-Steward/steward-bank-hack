'use strict';

const problem = require('./problem');

module.exports = ({ strapi }) => {
  const table = name => strapi.db.metadata.get('api::participation.' + name).tableName;
  const lock = query => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') query.forUpdate();
    return query;
  };
  async function current(trx, userId) {
    return lock(trx(table('join-profile')).where({ user_id: userId })).first();
  }
  async function view(trx, row) {
    if (!row) return null;
    let preferences = row.preferences_json;
    if (typeof preferences === 'string') preferences = JSON.parse(preferences);
    const proofStatus = { email: false, phone: false };
    for (const [channel, name, field, raw] of [['email', 'email', 'email_proof_id', 'email_raw'], ['sms', 'phone', 'phone_proof_id', 'phone_raw']]) {
      if (!row[field]) continue;
      const proof = await trx(table('contact-proof')).where({ id: row[field], raw_value: row[raw], superseded_at: null }).whereNotNull('consumed_at').first();
      if (!proof) continue;
      const contact = await trx(table('verified-contact')).where({ user_id: row.user_id, channel, destination_key: proof.destination_key, derivation_version: proof.derivation_version, revoked_at: null }).first();
      proofStatus[name] = Boolean(contact);
    }
    return {
      preferredNameRaw: row.preferred_name_raw, emailRaw: row.email_raw, phoneRaw: row.phone_raw,
      preferences, version: row.version,
      proofStatus,
    };
  }
  async function save(trx, userId, draft, emailProofId) {
    const row = await current(trx, userId);
    if (row && draft.profileVersion !== row.version) return 'conflict';
    if (!row && draft.profileVersion !== null) return 'conflict';
    const data = {
      preferredNameRaw: draft.preferredNameRaw, emailRaw: draft.emailRaw, phoneRaw: draft.phoneRaw,
      preferencesJson: draft.preferences, emailProofId, phoneProofId: null,
    };
    if (row) {
      if (row.email_raw === draft.emailRaw && emailProofId === undefined) data.emailProofId = row.email_proof_id;
      if (row.phone_raw === draft.phoneRaw) data.phoneProofId = row.phone_proof_id;
      if (data.emailProofId === undefined) data.emailProofId = null;
      await strapi.db.query('api::participation.join-profile').update({ where: { id: row.id }, data: { ...data, version: row.version + 1 } });
    } else {
      if (data.emailProofId === undefined) data.emailProofId = null;
      await strapi.db.query('api::participation.join-profile').create({ data: { ...data, userId, version: 1 } });
    }
    return 'saved';
  }
  return {
    async read(trx, userId) { return view(trx, await current(trx, userId)); },
    async forJoin(trx, userId, draft, emailProofId) {
      if (!draft.saveReusableProfile) return 'not_requested';
      return save(trx, userId, draft, emailProofId);
    },
    async update(trx, userId, edit) {
      const result = await save(trx, userId, { ...edit, profileVersion: edit.version }, undefined);
      if (result === 'conflict') problem('PROFILE_VERSION_CONFLICT', 409);
      return view(trx, await current(trx, userId));
    },
  };
};
