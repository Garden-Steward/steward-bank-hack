'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');

const uid = name => 'api::participation.' + name;
const key = () => crypto.randomUUID();
const table = name => strapi.db.metadata.get(uid(name)).tableName;
const create = (name, data) => strapi.db.query(uid(name)).create({ data });

async function copyNative(name, row, changes = {}) {
  const connection = strapi.db.connection;
  const saved = await connection(table(name)).where({ id: row.id }).first();
  delete saved.id;
  saved.document_id = crypto.randomBytes(12).toString('hex');
  return connection(table(name)).insert({ ...saved, ...changes });
}

const participation = () => ({ receiptId: key(), eventDocumentId: key(), gardenDocumentId: key(), userId: 101, rsvpState: 'confirmed', rsvpedAt: new Date().toISOString(), joinSnapshotJson: { source: 'synthetic foundation fixture' } });

beforeAll(async () => { await setupStrapi(); });
afterAll(async () => { await cleanupStrapi(); });

test('private native models load without draft/publish or generic public API routes', async () => {
  for (const name of ['join-intent', 'contact-proof', 'verified-contact', 'join-profile', 'participation', 'consent-receipt', 'sms-destination-state', 'event-participation-setting', 'participation-attempt', 'participation-request', 'participation-photo-card']) {
    const model = strapi.contentType(uid(name));
    expect(model.options.draftAndPublish).toBe(false);
    expect(model.pluginOptions['content-manager'].visible).toBe(false);
    expect(strapi.db.metadata.get(uid(name)).attributes.id.type).toBe('increments');
  }
  for (const path of ['/api/participations', '/api/join-intents', '/api/contact-proofs', '/api/join-profiles']) {
    await request(strapi.server.httpServer).get(path).expect(404);
  }
  expect(strapi.contentType(uid('join-profile')).attributes.phoneRaw.private).toBe(true);
  strapi.service(uid('participation')).assertStorageReady();
});

test('the database rejects duplicate event/user participation and request keys', async () => {
  const row = await create('participation', participation());
  await expect(copyNative('participation', row, { receipt_id: key() })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  const command = await create('participation-request', { actorOrBrowserScope: key(), operation: 'join', requestId: key(), requestHmac: key(), safeResultJson: { kind: 'confirmed' }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await expect(copyNative('participation-request', command)).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
});

test('the database rejects duplicate intent, proof receipt and profile keys', async () => {
  const intent = await create('join-intent', { receiptId: key(), eventDocumentId: key(), browserSecretHash: key(), requestId: key(), requestHmac: key(), draftJson: {}, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await expect(copyNative('join-intent', intent, { receipt_id: key() })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  const proof = await create('contact-proof', { receiptId: key(), purpose: 'email_login', rawValue: 'synthetic@example.com', deliveryValue: 'synthetic@example.com', destinationKey: key(), browserSecretHash: key(), codeHmac: key(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  await expect(copyNative('contact-proof', proof)).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  const profile = await create('join-profile', { userId: 202, preferredNameRaw: '  Synthetic Person  ', emailRaw: 'synthetic@example.com', phoneRaw: ' (415) 555-0100 ', preferencesJson: {} });
  await expect(copyNative('join-profile', profile)).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  await expect(copyNative('join-profile', profile, { user_id: 203, phone_raw: null })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_NOTNULL' });
});

test('one active verified owner survives revocation history and rejects conflicting reactivation', async () => {
  const first = await create('verified-contact', { channel: 'email', destinationKey: key(), userId: 301, verifiedAt: new Date().toISOString() });
  await expect(copyNative('verified-contact', first, { user_id: 302 })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  await strapi.db.query(uid('verified-contact')).update({ where: { id: first.id }, data: { revokedAt: new Date().toISOString() } });
  await copyNative('verified-contact', first, { user_id: 302, revoked_at: null });
  await expect(strapi.db.connection(table('verified-contact')).where({ id: first.id }).update({ revoked_at: null })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
});

test('native state constraints reject malformed insertion and mutation', async () => {
  const row = await create('participation', participation());
  await expect(copyNative('participation', row, { receipt_id: key(), event_document_id: key(), followup_state: 'queued' })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
  await expect(strapi.db.connection(table('participation')).where({ id: row.id }).update({ checked_in_at: new Date().toISOString() })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
  await expect(strapi.db.connection(table('participation')).where({ id: row.id }).update({ rsvped_at: null })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
  const proof = await create('contact-proof', { receiptId: key(), purpose: 'email_login', rawValue: 'fixture@example.com', deliveryValue: 'fixture@example.com', destinationKey: key(), browserSecretHash: key(), codeHmac: key(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  await expect(strapi.db.connection(table('contact-proof')).where({ id: proof.id }).update({ attempts: 6 })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
  await expect(strapi.db.connection(table('contact-proof')).where({ id: proof.id }).update({ purpose: 'profile_phone' })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
});

test('raw profile strings round trip unchanged including a320character email', async () => {
  const email = ' '.repeat(66) + 'x'.repeat(64) + '@' + 'd'.repeat(62) + '.' + 'd'.repeat(62) + '.' + 'd'.repeat(59) + '.com';
  expect(email.length).toBe(320);
  const values = { userId: 401, preferredNameRaw: '  Synthetic Person  ', emailRaw: email, phoneRaw: ' (415) 555-0100 ', preferencesJson: {} };
  const row = await create('join-profile', values);
  const saved = await strapi.db.query(uid('join-profile')).findOne({ where: { id: row.id } });
  expect(saved.preferredNameRaw).toBe(values.preferredNameRaw);
  expect(saved.emailRaw).toBe(email);
  expect(saved.phoneRaw).toBe(values.phoneRaw);
});

test('outer rollback removes the complete private write and storage setup is idempotent', async () => {
  const receiptId = key();
  await expect(strapi.db.transaction(async () => { await create('participation', { ...participation(), receiptId }); throw new Error('rollback foundation fixture'); })).rejects.toThrow('rollback foundation fixture');
  expect(await strapi.db.query(uid('participation')).findOne({ where: { receiptId } })).toBeNull();
  await strapi.service(uid('participation')).ensureStorage();
  strapi.service(uid('participation')).assertStorageReady();
});

test('constraint definition drift refuses readiness and missing owned constraints retry safely', async () => {
  const connection = strapi.db.connection;
  const name = 'gs_verified_contact_active_owner_unique';
  const original = await connection('sqlite_master').select('sql').where({ type: 'index', name }).first();
  await connection.raw('DROP INDEX ??', [name]);
  await connection.raw('CREATE INDEX ?? ON ?? (??, ??) WHERE ?? IS NULL', [name, table('verified-contact'), 'channel', 'destination_key', 'revoked_at']);
  const service = strapi.service(uid('participation'));
  await expect(service.ensureStorage()).rejects.toThrow('Participation storage constraint mismatch');
  expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
  expect((await connection.raw('PRAGMA index_list(??)', [table('verified-contact')])).find(index => index.name === name).unique).toBe(0);
  await connection.raw('DROP INDEX ??', [name]);
  await connection.raw(original.sql);
  const trigger = table('participation') + '_invariant_update';
  await connection.raw('DROP TRIGGER ??', [trigger]);
  await service.ensureStorage();
  service.assertStorageReady();
  expect(await connection('sqlite_master').where({ type: 'trigger', name: trigger }).first()).toBeTruthy();
  await expect(connection(table('participation')).update({ rsvped_at: null })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
});
