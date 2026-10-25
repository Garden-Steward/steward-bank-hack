'use strict';

const crypto = require('node:crypto');

const DISCLOSURE_VERSION = 'account-garden-news-v1';
const TEXT = {
  auto_enroll: 'Creating an account signs you up for Garden Steward email news. You can unsubscribe at any time.',
  unsubscribe: 'Unsubscribe from Garden Steward email news.',
  resubscribe: 'Subscribe to Garden Steward email news. You can unsubscribe at any time.',
  contact_change: 'Use this verified email for Garden Steward email news.',
};
const PRIORITY = { user_unsubscribe: 0, hard_bounce: 1, complaint: 2, manual: 3 };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('NEWSLETTER_INVALID_INPUT');
}

module.exports = ({ strapi }) => {
  const table = name => strapi.db.metadata.get('api::newsletter.' + name).tableName;
  const identityTable = name => strapi.db.metadata.get('api::participation.' + name).tableName;
  const lock = query => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') query.forUpdate();
    return query;
  };
  async function insert(trx, target, data, conflict) {
    const now = new Date();
    await trx(target).insert({ document_id: crypto.randomBytes(12).toString('hex'), created_at: now, updated_at: now, published_at: now, ...data }).onConflict(conflict).ignore();
  }
  async function account(userId, operation) {
    positive(userId);
    return strapi.db.transaction(async ({ trx }) => {
      const users = strapi.db.metadata.get('plugin::users-permissions.user').tableName;
      const user = await lock(trx(users).where({ id: userId })).first();
      if (!user || user.blocked) fail('NEWSLETTER_ACCOUNT_UNAVAILABLE');
      const subscription = await lock(trx(table('newsletter-subscription')).where({ user_id: userId })).first();
      return operation(trx, subscription);
    });
  }
  async function ownedEmail(trx, userId, contactId) {
    const contact = await lock(trx(identityTable('verified-contact')).where({ id: contactId, user_id: userId, channel: 'email', revoked_at: null })).first();
    if (!contact?.proof_id) return null;
    const proof = await trx(identityTable('contact-proof')).where({ id: contact.proof_id, destination_key: contact.destination_key, derivation_version: contact.derivation_version }).first();
    if (!proof?.consumed_at || proof.superseded_at) return null;
    if (proof.purpose === 'join_identity') {
      const intent = await trx(identityTable('join-intent')).where({ id: proof.intent_id, bound_actor_id: userId }).first();
      if (!intent || (proof.actor_id !== null && proof.actor_id !== userId)) return null;
      if (intent.bound_legacy_user_id !== null && intent.bound_legacy_user_id !== userId) return null;
    } else if (proof.purpose === 'profile_email' || proof.purpose === 'email_login') {
      if (proof.actor_id !== userId) return null;
    } else return null;
    return { contact, proof };
  }
  async function requireEmail(trx, userId, contactId) {
    positive(contactId);
    const email = await ownedEmail(trx, userId, contactId);
    if (!email) fail('NEWSLETTER_EMAIL_UNVERIFIED');
    return email;
  }
  const destination = subscription => ({ destination_key: subscription.destination_key, derivation_version: subscription.derivation_version });
  async function status(trx, subscription) {
    if (!subscription) return { preference: 'not_enrolled', state: 'not_enrolled', revision: 0 };
    const result = { preference: subscription.preference, state: 'unverified', revision: subscription.revision };
    if (subscription.preference === 'unsubscribed') return { ...result, state: 'unsubscribed' };
    if (subscription.preference !== 'subscribed') fail('NEWSLETTER_STORAGE_INVALID');
    const email = await ownedEmail(trx, subscription.user_id, subscription.verified_contact_id);
    if (!email || email.contact.destination_key !== subscription.destination_key || email.contact.derivation_version !== subscription.derivation_version) return result;
    const suppression = await trx(table('newsletter-suppression')).where(destination(subscription)).first();
    if (suppression) return { ...result, state: 'suppressed' };
    return { ...result, state: 'subscribed' };
  }
  async function event(trx, subscription, { sourceKey, action, requestDigest }) {
    await insert(trx, table('newsletter-preference-event'), {
      source_key: sourceKey, user_id: subscription.user_id, subscription_receipt_id: subscription.receipt_id,
      action, resulting_preference: subscription.preference, applied_revision: subscription.revision,
      text_version: DISCLOSURE_VERSION, text_hash: digest(TEXT[action]), recorded_at: new Date(), request_digest: requestDigest,
    }, 'source_key');
  }
  async function suppress(trx, key, reason, sourceKey) {
    const target = table('newsletter-suppression');
    const now = new Date();
    const changes = { reason, source_key: sourceKey, recorded_at: now, updated_at: now };
    await trx(target).insert({ document_id: crypto.randomBytes(12).toString('hex'), created_at: now, published_at: now, ...key, ...changes })
      .onConflict(['derivation_version', 'destination_key']).merge(changes)
      .whereRaw("CASE ?? WHEN 'user_unsubscribe' THEN 0 WHEN 'hard_bounce' THEN 1 WHEN 'complaint' THEN 2 WHEN 'manual' THEN 3 ELSE -1 END < ?", [target + '.reason', PRIORITY[reason]]);
    const current = await trx(target).where(key).first();
    if (!Object.hasOwn(PRIORITY, current.reason)) fail('NEWSLETTER_STORAGE_INVALID');
  }
  async function command(input, action, apply) {
    positive(input.expectedRevision);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9._:-]{16,100}$/.test(input.requestId)) fail('NEWSLETTER_INVALID_INPUT');
    const sourceKey = 'command:' + input.userId + ':' + input.requestId;
    const requestDigest = digest({ action, expectedRevision: input.expectedRevision, verifiedContactId: input.verifiedContactId });
    return account(input.userId, async (trx, subscription) => {
      if (!subscription) fail('NEWSLETTER_NOT_ENROLLED');
      const previous = await trx(table('newsletter-preference-event')).where({ source_key: sourceKey }).first();
      if (previous) {
        if (previous.request_digest !== requestDigest) fail('NEWSLETTER_REQUEST_CONFLICT');
        return { status: await status(trx, subscription), change: { appliedRevision: previous.applied_revision, replayed: true } };
      }
      if (subscription.revision !== input.expectedRevision) fail('NEWSLETTER_REVISION_CONFLICT');
      const updated = await apply(trx, subscription, sourceKey);
      await event(trx, updated, { sourceKey, action, requestDigest });
      return { status: await status(trx, updated), change: { appliedRevision: updated.revision, replayed: false } };
    });
  }
  return {
    disclosure: { version: DISCLOSURE_VERSION, text: TEXT.auto_enroll },
    async ensureAccountSubscription({ userId, verifiedContactId, disclosureVersion }) {
      if (disclosureVersion !== DISCLOSURE_VERSION) fail('NEWSLETTER_DISCLOSURE_CHANGED');
      return account(userId, async (trx, subscription) => {
        const { contact, proof } = await requireEmail(trx, userId, verifiedContactId);
        if (subscription) return status(trx, subscription);
        await insert(trx, table('newsletter-subscription'), {
          receipt_id: crypto.randomBytes(32).toString('hex'), user_id: userId, preference: 'subscribed',
          email_raw: proof.raw_value, delivery_email: proof.delivery_value,
          destination_key: contact.destination_key, derivation_version: contact.derivation_version,
          verified_contact_id: contact.id, revision: 1, disclosure_version: DISCLOSURE_VERSION, first_enrolled_at: new Date(),
        }, 'user_id');
        const saved = await trx(table('newsletter-subscription')).where({ user_id: userId }).first();
        await event(trx, saved, { sourceKey: 'auto:' + userId, action: 'auto_enroll', requestDigest: digest({ userId, disclosureVersion }) });
        return status(trx, saved);
      });
    },
    async getAccountStatus(userId) {
      return account(userId, (trx, subscription) => status(trx, subscription));
    },
    async setAccountPreference(input) {
      let action;
      if (input.preference === 'subscribed') action = 'resubscribe';
      else if (input.preference === 'unsubscribed') action = 'unsubscribe';
      else fail('NEWSLETTER_INVALID_INPUT');
      return command(input, action, async (trx, subscription, sourceKey) => {
        if (action === 'resubscribe') {
          await requireEmail(trx, input.userId, subscription.verified_contact_id);
          await trx(table('newsletter-suppression')).where({ ...destination(subscription), reason: 'user_unsubscribe' }).delete();
        } else await suppress(trx, destination(subscription), 'user_unsubscribe', sourceKey);
        const updated = { ...subscription, preference: input.preference, revision: subscription.revision + 1, unsubscribed_at: null };
        if (action === 'unsubscribe') updated.unsubscribed_at = new Date();
        await trx(table('newsletter-subscription')).where({ id: subscription.id }).update({ preference: updated.preference, revision: updated.revision, unsubscribed_at: updated.unsubscribed_at, updated_at: new Date() });
        return updated;
      });
    },
    async changeAccountEmail(input) {
      return command(input, 'contact_change', async (trx, subscription) => {
        const { contact, proof } = await requireEmail(trx, input.userId, input.verifiedContactId);
        const changes = { email_raw: proof.raw_value, delivery_email: proof.delivery_value, destination_key: contact.destination_key, derivation_version: contact.derivation_version, verified_contact_id: contact.id, revision: subscription.revision + 1, updated_at: new Date() };
        await trx(table('newsletter-subscription')).where({ id: subscription.id }).update(changes);
        return { ...subscription, ...changes };
      });
    },
    async suppressDestination({ derivationVersion, destinationKey, reason, sourceKey }) {
      positive(derivationVersion);
      if (!['hard_bounce', 'complaint', 'manual'].includes(reason) || typeof destinationKey !== 'string' || !/^[0-9a-f]{64}$/.test(destinationKey) || typeof sourceKey !== 'string' || sourceKey.length < 1 || sourceKey.length > 153) fail('NEWSLETTER_INVALID_INPUT');
      await strapi.db.transaction(async ({ trx }) => { await suppress(trx, { derivation_version: derivationVersion, destination_key: destinationKey }, reason, 'sticky:' + sourceKey); });
    },
  };
};
