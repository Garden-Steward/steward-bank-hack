'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');

const key = () => crypto.randomUUID();
const destinationKey = () => crypto.randomBytes(32).toString('hex');
const uid = name => 'api::newsletter.' + name;
const table = name => strapi.db.metadata.get(uid(name)).tableName;
const query = name => strapi.db.query(uid(name));
const identity = name => strapi.db.query('api::participation.' + name);
let service;

async function user() {
  return strapi.db.query('plugin::users-permissions.user').create({ data: { username: key(), email: key() + '@example.com', provider: 'local', confirmed: true, blocked: false } });
}
async function email(account, options = {}) {
  const purpose = options.purpose || 'profile_email';
  const data = { receiptId: key(), purpose, actorId: account.id, rawValue: '  Synthetic+Garden@Example.com  ', deliveryValue: 'synthetic+garden@example.com', destinationKey: destinationKey(), browserSecretHash: destinationKey(), codeHmac: destinationKey(), expiresAt: new Date(Date.now() + 60000).toISOString(), consumedAt: new Date().toISOString(), ...options };
  if (purpose === 'join_identity') {
    const intent = await identity('join-intent').create({ data: { receiptId: key(), eventDocumentId: key(), boundActorId: account.id, browserSecretHash: destinationKey(), requestId: key(), requestHmac: destinationKey(), draftJson: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    data.intentId = intent.id;
  }
  const proof = await identity('contact-proof').create({ data });
  const contact = await identity('verified-contact').create({ data: { channel: 'email', destinationKey: proof.destinationKey, derivationVersion: proof.derivationVersion, userId: account.id, verifiedAt: new Date().toISOString(), proofId: proof.id } });
  return { contact, proof };
}
const enroll = (account, contact) => service.ensureAccountSubscription({ userId: account.id, verifiedContactId: contact.id, disclosureVersion: service.disclosure.version });
async function enrolled() {
  const account = await user();
  const owned = await email(account);
  await enroll(account, owned.contact);
  return { account, ...owned };
}
async function preference(account, value, revision, requestId = key()) {
  return service.setAccountPreference({ userId: account.id, preference: value, expectedRevision: revision, requestId });
}

beforeAll(async () => { await setupStrapi(); service = strapi.service(uid('newsletter')); });
afterAll(async () => { await cleanupStrapi(); });

test('newsletter storage is private and exposes no generic routes', async () => {
  for (const name of ['newsletter-subscription', 'newsletter-suppression', 'newsletter-preference-event']) {
    const model = strapi.contentType(uid(name));
    expect(model.options.draftAndPublish).toBe(false);
    expect(Object.values(model.attributes).filter(attribute => attribute.required).every(attribute => attribute.private)).toBe(true);
  }
  for (const path of ['/api/newsletter-subscriptions', '/api/newsletter-suppressions', '/api/newsletter-preference-events']) await request(strapi.server.httpServer).get(path).expect(404);
});

test('automatic enrollment stores exact proof values and one receipt despite repeated calls', async () => {
  const { account, contact, proof } = await enrolled();
  expect(await enroll(account, contact)).toEqual({ preference: 'subscribed', state: 'subscribed', revision: 1 });
  const saved = await query('newsletter-subscription').findOne({ where: { userId: account.id } });
  expect(saved.emailRaw).toBe(proof.rawValue);
  expect(saved.deliveryEmail).toBe(proof.deliveryValue);
  expect(await query('newsletter-subscription').count({ where: { userId: account.id } })).toBe(1);
  expect(await query('newsletter-preference-event').count({ where: { userId: account.id } })).toBe(1);
});

test('concurrent automatic enrollment creates one subscription and one receipt', async () => {
  const account = await user();
  const { contact } = await email(account);
  const results = await Promise.all([enroll(account, contact), enroll(account, contact)]);
  expect(results).toEqual([{ preference: 'subscribed', state: 'subscribed', revision: 1 }, { preference: 'subscribed', state: 'subscribed', revision: 1 }]);
  expect(await query('newsletter-subscription').count({ where: { userId: account.id } })).toBe(1);
  expect(await query('newsletter-preference-event').count({ where: { userId: account.id } })).toBe(1);
});

test('unverified, foreign, revoked and SMS-purpose contacts cannot enroll', async () => {
  const account = await user();
  const foreign = await user();
  const { contact } = await email(foreign);
  await expect(enroll(account, contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  const unconsumed = await email(account, { consumedAt: null });
  await expect(enroll(account, unconsumed.contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  const sms = await email(account, { purpose: 'profile_phone' });
  await expect(enroll(account, sms.contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  const revoked = await email(account);
  await identity('verified-contact').update({ where: { id: revoked.contact.id }, data: { revokedAt: new Date().toISOString() } });
  await expect(enroll(account, revoked.contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  expect(await query('newsletter-subscription').count({ where: { userId: account.id } })).toBe(0);
});

test.each(['join_identity', 'email_login', 'profile_email'])('%s proof stays bound to the exact resolved actor', async purpose => {
  const account = await user();
  const { contact, proof } = await email(account, { purpose });
  const foreign = await user();
  if (purpose === 'join_identity') await identity('join-intent').update({ where: { id: proof.intentId }, data: { boundActorId: foreign.id } });
  else await identity('contact-proof').update({ where: { id: proof.id }, data: { actorId: foreign.id } });
  await expect(enroll(account, contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  if (purpose === 'join_identity') await identity('join-intent').update({ where: { id: proof.intentId }, data: { boundActorId: account.id } });
  else await identity('contact-proof').update({ where: { id: proof.id }, data: { actorId: account.id } });
  expect((await enroll(account, contact)).state).toBe('subscribed');
});

test('outer account rollback removes its newsletter enrollment and receipt', async () => {
  let userId;
  await expect(strapi.db.transaction(async () => {
    const account = await user(); userId = account.id;
    const { contact } = await email(account);
    await enroll(account, contact);
    throw new Error('synthetic account rollback');
  })).rejects.toThrow('synthetic account rollback');
  expect(await query('newsletter-subscription').count({ where: { userId } })).toBe(0);
  expect(await query('newsletter-preference-event').count({ where: { userId } })).toBe(0);
});

test('automatic replay never changes a selected email or resurrects an unsubscribe', async () => {
  const { account, contact: original } = await enrolled();
  await preference(account, 'unsubscribed', 1);
  const newer = await email(account, { rawValue: ' Newer@Example.com ', deliveryValue: 'newer@example.com' });
  await service.changeAccountEmail({ userId: account.id, verifiedContactId: newer.contact.id, expectedRevision: 2, requestId: key() });
  expect(await enroll(account, original)).toEqual({ preference: 'unsubscribed', state: 'unsubscribed', revision: 3 });
  const saved = await query('newsletter-subscription').findOne({ where: { userId: account.id } });
  expect(saved.verifiedContactId).toBe(newer.contact.id);
  expect(saved.emailRaw).toBe(' Newer@Example.com ');
});

test('explicit command replay returns current status, preserves receipts and rejects changed inputs', async () => {
  const { account, contact } = await enrolled();
  const requestId = key();
  const original = await preference(account, 'unsubscribed', 1, requestId);
  expect(original.change).toEqual({ appliedRevision: 2, replayed: false });
  await preference(account, 'subscribed', 2);
  const replay = await preference(account, 'unsubscribed', 1, requestId);
  expect(replay).toEqual({ status: { preference: 'subscribed', state: 'subscribed', revision: 3 }, change: { appliedRevision: 2, replayed: true } });
  await expect(preference(account, 'subscribed', 1, requestId)).rejects.toMatchObject({ code: 'NEWSLETTER_REQUEST_CONFLICT' });
  await expect(service.changeAccountEmail({ userId: account.id, verifiedContactId: contact.id, expectedRevision: 1, requestId })).rejects.toMatchObject({ code: 'NEWSLETTER_REQUEST_CONFLICT' });
  await expect(preference(account, 'unsubscribed', 1)).rejects.toMatchObject({ code: 'NEWSLETTER_REVISION_CONFLICT' });
});

test('sticky suppression cannot be weakened or cleared by user preference changes', async () => {
  const { account, contact } = await enrolled();
  const data = { derivationVersion: 1, destinationKey: contact.destinationKey };
  await service.suppressDestination({ ...data, reason: 'complaint', sourceKey: key() });
  await service.suppressDestination({ ...data, reason: 'hard_bounce', sourceKey: key() });
  await preference(account, 'unsubscribed', 1);
  await preference(account, 'subscribed', 2);
  expect((await service.getAccountStatus(account.id)).state).toBe('suppressed');
  expect((await query('newsletter-suppression').findOne({ where: { destinationKey: contact.destinationKey } })).reason).toBe('complaint');
  await expect(service.suppressDestination({ ...data, reason: 'user_unsubscribe', sourceKey: key() })).rejects.toMatchObject({ code: 'NEWSLETTER_INVALID_INPUT' });
});

test('revoked or blocked accounts do not remain eligible and do not fall back to another email', async () => {
  const { account, contact } = await enrolled();
  await email(account);
  await identity('verified-contact').update({ where: { id: contact.id }, data: { revokedAt: new Date().toISOString() } });
  expect((await service.getAccountStatus(account.id)).state).toBe('unverified');
  await strapi.db.query('plugin::users-permissions.user').update({ where: { id: account.id }, data: { blocked: true } });
  await expect(service.getAccountStatus(account.id)).rejects.toMatchObject({ code: 'NEWSLETTER_ACCOUNT_UNAVAILABLE' });
});

test('outer rollback restores preference, suppression and command receipt together', async () => {
  const { account, contact } = await enrolled();
  const requestId = key();
  await expect(strapi.db.transaction(async () => { await preference(account, 'unsubscribed', 1, requestId); throw new Error('synthetic preference rollback'); })).rejects.toThrow('synthetic preference rollback');
  expect(await service.getAccountStatus(account.id)).toEqual({ preference: 'subscribed', state: 'subscribed', revision: 1 });
  expect(await query('newsletter-suppression').count({ where: { destinationKey: contact.destinationKey } })).toBe(0);
  expect(await query('newsletter-preference-event').count({ where: { sourceKey: 'command:' + account.id + ':' + requestId } })).toBe(0);
});

test('the database rejects duplicate owner, destination and receipt keys and null raw email', async () => {
  const { account, contact } = await enrolled();
  const connection = strapi.db.connection;
  async function duplicate(name, changes) {
    const saved = await connection(table(name)).first();
    delete saved.id;
    return connection(table(name)).insert({ ...saved, document_id: key(), ...changes });
  }
  await expect(duplicate('newsletter-subscription', { receipt_id: key() })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  await expect(duplicate('newsletter-subscription', { user_id: account.id + 10000 })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  await expect(duplicate('newsletter-subscription', { receipt_id: key(), user_id: account.id + 10000, email_raw: null })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_NOTNULL' });
  await service.suppressDestination({ derivationVersion: 1, destinationKey: contact.destinationKey, reason: 'manual', sourceKey: key() });
  const saved = await connection(table('newsletter-suppression')).where({ destination_key: contact.destinationKey }).first();
  delete saved.id;
  await expect(connection(table('newsletter-suppression')).insert({ ...saved, document_id: key(), source_key: key() })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  await expect(duplicate('newsletter-preference-event', {})).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
});

test('a prior destination suppression blocks first enrollment without pretending it was cleared', async () => {
  const account = await user();
  const { contact } = await email(account);
  await service.suppressDestination({ derivationVersion: 1, destinationKey: contact.destinationKey, reason: 'hard_bounce', sourceKey: key() });
  expect(await enroll(account, contact)).toEqual({ preference: 'subscribed', state: 'suppressed', revision: 1 });
  expect(await enroll(account, contact)).toEqual({ preference: 'subscribed', state: 'suppressed', revision: 1 });
});

test('changed disclosure refuses enrollment and a320character raw email round trips unchanged', async () => {
  const account = await user();
  const rawValue = '  ' + 'x'.repeat(306) + '@example.com';
  expect(rawValue.length).toBe(320);
  const { contact } = await email(account, { rawValue });
  await expect(service.ensureAccountSubscription({ userId: account.id, verifiedContactId: contact.id, disclosureVersion: 'old-version' })).rejects.toMatchObject({ code: 'NEWSLETTER_DISCLOSURE_CHANGED' });
  expect(await query('newsletter-subscription').count({ where: { userId: account.id } })).toBe(0);
  await enroll(account, contact);
  expect((await query('newsletter-subscription').findOne({ where: { userId: account.id } })).emailRaw).toBe(rawValue);
});

test('an actorless join proof needs the exact bound intent and a consistent legacy actor', async () => {
  const account = await user();
  const { contact, proof } = await email(account, { purpose: 'join_identity', actorId: null });
  const foreign = await user();
  await identity('join-intent').update({ where: { id: proof.intentId }, data: { boundActorId: null } });
  await expect(enroll(account, contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  await identity('join-intent').update({ where: { id: proof.intentId }, data: { boundActorId: account.id, boundLegacyUserId: foreign.id } });
  await expect(enroll(account, contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  await identity('join-intent').update({ where: { id: proof.intentId }, data: { boundLegacyUserId: account.id } });
  expect((await enroll(account, contact)).state).toBe('subscribed');
});

test.each(['superseded', 'destination', 'version'])('%s proof mismatch refuses account enrollment', async mismatch => {
  const account = await user();
  const { contact, proof } = await email(account);
  const changes = {};
  if (mismatch === 'superseded') changes.supersededAt = new Date().toISOString();
  if (mismatch === 'destination') changes.destinationKey = destinationKey();
  if (mismatch === 'version') changes.derivationVersion = 2;
  await identity('contact-proof').update({ where: { id: proof.id }, data: changes });
  await expect(enroll(account, contact)).rejects.toMatchObject({ code: 'NEWSLETTER_EMAIL_UNVERIFIED' });
  expect(await query('newsletter-subscription').count({ where: { userId: account.id } })).toBe(0);
});

test('expiry of an already consumed code does not revoke its verified email ownership', async () => {
  const account = await user();
  const { contact } = await email(account, { consumedAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() });
  expect((await enroll(account, contact)).state).toBe('subscribed');
});
