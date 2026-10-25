'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');
const createCrypto = require('../src/api/auth/join-identity-internal/proof-crypto');
const elapsedDestination = require('./helpers/identity-time');

const uuid = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString('hex');
const MASTER = secret();
const tools = createCrypto(MASTER);
const eventUid = 'api::volunteer-day.volunteer-day';
let previousKey;
let previousEnabled;
let service;
let garden;
let interest;
let originalSend;
let inbox;
const query = name => strapi.db.query('api::participation.' + name);
const users = () => strapi.db.query('plugin::users-permissions.user');

async function event(extra = {}) {
  return strapi.documents(eventUid).create({ status: 'published', data: {
    title: 'Synthetic garden workday', garden: garden.documentId, startDatetime: new Date(Date.now() + 86400000).toISOString(),
    accessibility: 'Public', ...extra,
  } });
}
function draft(extra = {}) {
  return {
    preferredNameRaw: '  Person  ', emailRaw: '  Person.' + uuid() + '@EXAMPLE.COM  ', phoneRaw: '  +1 (510) 555-0123  ',
    preferences: { gardenDocumentIds: [garden.documentId], interestIds: [interest.documentId], offeredSkillIds: ['plant_care'], learningSkillIds: [], availabilityIds: ['weekend_mornings'], taskPreferenceIds: ['light_garden'], experience: null },
    accessRequestRaw: '  Private access note  ', saveReusableProfile: true, profileVersion: null, ...extra,
  };
}
async function pendingAfterCooldown({ selected = null, values = null, actorId = null } = {}) {
  if (!selected) selected = await event();
  if (!values) values = draft();
  const body = { requestId: uuid(), browserSecret: secret(), draft: values };
  await elapsedDestination(strapi, tools, values.emailRaw);
  const result = await service.submit(actorId, selected.documentId, body, '127.0.0.1');
  return { selected, body, result, verify: { requestId: uuid(), browserSecret: body.browserSecret, code: inbox[inbox.length - 1].text.match(/code is (\d{8})/)[1] } };
}
const verify = (item, actorId = null) => service.completeProof(actorId, item.result.join.intentId, item.verify);
const privateProfile = id => query('join-profile').findOne({ where: { userId: id } });
async function legacyUser(data) {
  const enabled = process.env.PARTICIPATION_ENABLED;
  process.env.PARTICIPATION_ENABLED = 'false';
  try { return await users().create({ data }); }
  finally { process.env.PARTICIPATION_ENABLED = enabled; }
}
async function permit(type, action) {
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type } });
  const permissions = strapi.db.query('plugin::users-permissions.permission');
  if (!(await permissions.findOne({ where: { role: role.id, action } }))) await permissions.create({ data: { role: role.id, action } });
  return role;
}

beforeAll(async () => {
  previousKey = process.env.PARTICIPATION_IDENTITY_KEY;
  previousEnabled = process.env.PARTICIPATION_ENABLED;
  process.env.PARTICIPATION_IDENTITY_KEY = MASTER;
  process.env.PARTICIPATION_ENABLED = 'true';
  await setupStrapi();
  service = strapi.service('api::participation.participation');
  originalSend = strapi.plugin('email').service('email').send;
  strapi.plugin('email').service('email').send = async value => { expect(strapi.db.inTransaction()).toBe(false); inbox.push(value); return { simulated: true }; };
  garden = await strapi.documents('api::garden.garden').create({ status: 'published', data: { title: 'Synthetic public garden', slug: 'join-garden', sms_slug: 'join-garden' } });
  interest = await strapi.documents('api::interest.interest').create({ status: 'published', data: { tag: 'Growing food' } });
}, 120000);
beforeEach(() => { inbox = []; });
afterAll(async () => {
  await strapi.service('api::auth.email-login').drain();
  strapi.plugin('email').service('email').send = originalSend;
  await cleanupStrapi();
  if (previousKey === undefined) delete process.env.PARTICIPATION_IDENTITY_KEY;
  else process.env.PARTICIPATION_IDENTITY_KEY = previousKey;
  if (previousEnabled === undefined) delete process.env.PARTICIPATION_ENABLED;
  else process.env.PARTICIPATION_ENABLED = previousEnabled;
});

test('options use real published garden/interest identities and disclose required phone and automatic newsletter', async () => {
  const options = await service.options();
  expect(options.required).toEqual(['preferredNameRaw', 'emailRaw', 'phoneRaw']);
  expect(options.preferences.gardenDocumentIds).toContainEqual({ id: garden.documentId, label: garden.title });
  expect(options.preferences.interestIds).toContainEqual({ id: interest.documentId, label: interest.tag });
  expect(options.newsletter).toMatchObject({ version: 'account-garden-news-v1' });
});

test('a guest is pending until proof and then commits exact details, own receipt, account and newsletter', async () => {
  const before = await users().count();
  const item = await pendingAfterCooldown();
  expect(item.result.join).toMatchObject({ kind: 'pending_verification', verification: 'simulated' });
  expect(await users().count()).toBe(before);
  expect(await query('participation').count()).toBe(0);
  const result = await verify(item);
  expect(result.join).toMatchObject({ kind: 'confirmed', profileSave: 'saved', receipt: { eventDocumentId: item.selected.documentId, rsvp: 'confirmed', checkedInAt: null, followup: { state: 'not_planned' } }, outreach: { sms: 'unchanged', newsletter: 'subscribed' } });
  expect(result.sessionActorId).toBeGreaterThan(0);
  expect(result.join.event.eventPath).toBe('/d/' + item.selected.documentId);
  expect(await users().count()).toBe(before + 1);
  const profile = await service.readOwnProfile(result.sessionActorId);
  expect(profile).toMatchObject({ preferredNameRaw: item.body.draft.preferredNameRaw, emailRaw: item.body.draft.emailRaw, phoneRaw: item.body.draft.phoneRaw, proofStatus: { email: true, phone: false }, version: 1 });
  expect(profile).not.toHaveProperty('accessRequestRaw');
  const saved = await query('participation').findOne({ where: { receiptId: result.join.receipt.receiptId } });
  expect(saved.accessRequestRaw).toBe(item.body.draft.accessRequestRaw);
  expect(saved.joinSnapshotJson).toMatchObject({ emailRaw: item.body.draft.emailRaw, phoneRaw: item.body.draft.phoneRaw });
  expect(JSON.stringify(result.join)).not.toContain(item.body.draft.emailRaw);
  expect(JSON.stringify(result.join)).not.toContain(item.body.draft.accessRequestRaw);
  expect(inbox).toHaveLength(1);
});

test('exact verification replay returns the own receipt without another session or duplicate rows', async () => {
  const item = await pendingAfterCooldown();
  const first = await verify(item);
  const replay = await verify(item);
  expect(replay.join).toEqual(first.join);
  expect(replay).not.toHaveProperty('sessionActorId');
  expect(await query('participation').count({ where: { userId: first.sessionActorId, eventDocumentId: item.selected.documentId } })).toBe(1);
  expect((await service.submit(null, item.selected.documentId, item.body, '127.0.0.1')).join.kind).toBe('already_confirmed');
  await expect(service.completeProof(null, item.result.join.intentId, { ...item.verify, code: '00000000' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
});

test('wrong-code retry with one UUID commits one guess and a different UUID commits the next guess', async () => {
  const item = await pendingAfterCooldown();
  const wrong = item.verify.code.slice(0, 7) + String((Number(item.verify.code[7]) + 1) % 10);
  const body = { ...item.verify, code: wrong };
  expect((await service.completeProof(null, item.result.join.intentId, body)).join.kind).toBe('invalid_proof');
  expect((await service.completeProof(null, item.result.join.intentId, body)).join.kind).toBe('invalid_proof');
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).attempts).toBe(1);
  await service.completeProof(null, item.result.join.intentId, { ...body, requestId: uuid() });
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).attempts).toBe(2);
  expect((await service.completeProof(null, item.result.join.intentId, { ...item.verify, requestId: uuid() })).join.kind).toBe('confirmed');
});

test('wrong browser cannot inspect or consume the pending intent', async () => {
  const item = await pendingAfterCooldown();
  expect((await service.completeProof(null, item.result.join.intentId, { ...item.verify, browserSecret: secret() })).join.kind).toBe('invalid_proof');
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).attempts).toBe(0);
});

test('new UUID guesses after the five-attempt cap do not grow the verification ledger', async () => {
  const item = await pendingAfterCooldown();
  const wrong = item.verify.code.slice(0, 7) + String((Number(item.verify.code[7]) + 1) % 10);
  for (let index = 0; index < 8; index++) await service.completeProof(null, item.result.join.intentId, { ...item.verify, requestId: uuid(), code: wrong });
  const requests = strapi.db.metadata.get('api::participation.participation-request').tableName;
  const count = await strapi.db.connection(requests).where({ operation: 'participation:verify:' + item.result.join.intentId }).count('* as count').first();
  expect(Number(count.count)).toBe(5);
});

test('authenticated exact email owner joins directly and profile conflict preserves a valid RSVP snapshot', async () => {
  const item = await pendingAfterCooldown(); const first = await verify(item);
  const selected = await event();
  const changed = draft({ emailRaw: item.body.draft.emailRaw, preferredNameRaw: '  Event-only name  ', profileVersion: 999 });
  const body = { requestId: uuid(), browserSecret: secret(), draft: changed };
  const result = await service.submit(first.sessionActorId, selected.documentId, body, '127.0.0.1');
  expect(result.join).toMatchObject({ kind: 'confirmed', profileSave: 'conflict', receipt: { rsvp: 'confirmed' } });
  expect((await privateProfile(first.sessionActorId)).preferredNameRaw).toBe(item.body.draft.preferredNameRaw);
  expect((await query('participation').findOne({ where: { receiptId: result.join.receipt.receiptId } })).joinSnapshotJson.preferredNameRaw).toBe(changed.preferredNameRaw);
  expect((await service.submit(first.sessionActorId, selected.documentId, body, '127.0.0.1')).join).toEqual(result.join);
  expect(inbox).toHaveLength(1);
});

test.each([
  ['required phone', { phoneRaw: '' }], ['phone syntax', { phoneRaw: 'not a phone' }], ['required name', { preferredNameRaw: ' ' }],
  ['invalid email', { emailRaw: 'example.com' }], ['unknown input', { newsletter: true }],
  ['invalid profile version', { profileVersion: 0 }], ['oversized access', { accessRequestRaw: 'x'.repeat(2001) }],
])('invalid draft fails before proof, account or RSVP writes (%s)', async (label, fields) => {
  const selected = await event(); const before = await query('join-intent').count();
  await expect(service.submit(null, selected.documentId, { requestId: uuid(), browserSecret: secret(), draft: draft(fields) }, '127.0.0.1')).rejects.toMatchObject({ status: 422 });
  expect(await query('join-intent').count()).toBe(before); expect(inbox).toEqual([]);
});

test.each([
  ['past', { startDatetime: new Date(Date.now() - 60000).toISOString() }, 409],
  ['canceled', { canceled: true }, 409], ['disabled', { disabled: true }, 409],
  ['private', { accessibility: 'Garden Members' }, 404], ['external', { partiful_link: 'https://partiful.com/e/synthetic' }, 409],
  ['gardenless', { garden: null }, 404],
])('join policy refuses an unavailable or hidden event (%s)', async (label, fields, status) => {
  const selected = await event(fields); const before = await query('join-intent').count();
  await expect(service.submit(null, selected.documentId, { requestId: uuid(), browserSecret: secret(), draft: draft() }, '127.0.0.1')).rejects.toMatchObject({ status });
  expect(await query('join-intent').count()).toBe(before); expect(inbox).toEqual([]);
});

test('event cancellation while proof is pending prevents account and RSVP completion', async () => {
  const item = await pendingAfterCooldown(); const before = await users().count();
  await strapi.documents(eventUid).update({ documentId: item.selected.documentId, status: 'published', data: { canceled: true } });
  await expect(verify(item)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE', status: 409 });
  expect(await users().count()).toBe(before);
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).consumedAt).toBeNull();
});

test('legacy email proof requires exact signed-in actor resume and does not create another account', async () => {
  const email = 'Legacy.' + uuid() + '@example.com';
  const legacy = await legacyUser({ username: uuid(), email, provider: 'local', confirmed: true, blocked: false });
  const other = await users().create({ data: { username: uuid(), provider: 'local', confirmed: true, blocked: false } });
  const item = await pendingAfterCooldown({ values: draft({ emailRaw: email }) }); const before = await users().count();
  const result = await verify(item);
  expect(result.join).toMatchObject({ kind: 'sign_in_required', canResume: true });
  expect(result).not.toHaveProperty('sessionActorId'); expect(JSON.stringify(result)).not.toContain('legacyUserId');
  const body = { requestId: uuid(), browserSecret: item.body.browserSecret };
  await expect(service.resume(other.id, item.result.join.intentId, body)).rejects.toMatchObject({ code: 'IDENTITY_ACCOUNT_CHANGED' });
  const resumed = await service.resume(legacy.id, item.result.join.intentId, body);
  expect(resumed.join.kind).toBe('confirmed'); expect(resumed).not.toHaveProperty('sessionActorId');
  expect(await users().count()).toBe(before);
});

test('self profile edit preserves raw input, clears changed contact proof and leaves login credentials alone', async () => {
  const item = await pendingAfterCooldown(); const result = await verify(item); const userId = result.sessionActorId;
  const user = await users().findOne({ where: { id: userId } });
  const current = await service.readOwnProfile(userId);
  const edit = { requestId: uuid(), version: current.version, preferredNameRaw: '  New raw name  ', emailRaw: '  Other.' + uuid() + '@EXAMPLE.COM  ', phoneRaw: '  +44 20 7946 0958  ', preferences: current.preferences };
  const saved = await service.saveOwnProfile(userId, edit);
  expect(saved.profile).toMatchObject({ preferredNameRaw: edit.preferredNameRaw, emailRaw: edit.emailRaw, phoneRaw: edit.phoneRaw, proofStatus: { email: false, phone: false }, version: 2 });
  expect((await users().findOne({ where: { id: userId } })).email).toBe(user.email);
  expect((await service.saveOwnProfile(userId, edit)).profile.version).toBe(2);
  await expect(service.saveOwnProfile(userId, { ...edit, requestId: uuid() })).rejects.toMatchObject({ code: 'PROFILE_VERSION_CONFLICT', status: 409 });
});

test('own receipt read cannot expose another user registration', async () => {
  const item = await pendingAfterCooldown(); const result = await verify(item);
  const other = await users().create({ data: { username: uuid(), provider: 'local', blocked: false } });
  expect(await service.ownReceipt(other.id, item.selected.documentId)).toBeNull();
  expect(await service.ownReceipt(result.sessionActorId, item.selected.documentId)).toEqual(result.join.receipt);
});

test('accepted pending submit replay reuses its proof and changed raw input conflicts', async () => {
  const item = await pendingAfterCooldown();
  const first = await service.submit(null, item.selected.documentId, item.body, '127.0.0.1');
  expect(first).toEqual(item.result); expect(inbox).toHaveLength(1);
  await expect(service.submit(null, item.selected.documentId, { ...item.body, draft: { ...item.body.draft, preferredNameRaw: 'Different' } }, '127.0.0.1')).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
});

test('a fresh join UUID during destination cooldown rolls back its provisional intent and reports the wait', async () => {
  const item = await pendingAfterCooldown();
  const before = { intents: await query('join-intent').count(), proofs: await query('contact-proof').count(), requests: await query('participation-request').count() };
  const response = await request(strapi.server.httpServer).post('/api/volunteer-days/' + item.selected.documentId + '/joins').send({ ...item.body, requestId: uuid() }).expect(400);
  expect(response.body.error.code).toBe('IDENTITY_COOLDOWN');
  expect(response.headers['retry-after']).toBe('60');
  expect(await query('join-intent').count()).toBe(before.intents);
  expect(await query('contact-proof').count()).toBe(before.proofs);
  expect(await query('participation-request').count()).toBe(before.requests);
  expect(inbox).toHaveLength(1);
});

test('resend cooldown preserves its original generation and later resend requires the new code', async () => {
  const item = await pendingAfterCooldown();
  const body = { requestId: uuid(), browserSecret: item.body.browserSecret };
  await expect(service.resend(item.result.join.intentId, body, '127.0.0.1')).rejects.toMatchObject({ code: 'IDENTITY_COOLDOWN', status: 400 });
  const proofs = strapi.db.metadata.get('api::participation.contact-proof').tableName;
  await strapi.db.connection(proofs).where({ receipt_id: item.result.join.proofId }).update({ expires_at: new Date(Date.now() + 600000 - 61000) });
  await elapsedDestination(strapi, tools, item.body.draft.emailRaw);
  expect((await service.resend(item.result.join.intentId, body, '127.0.0.1')).join.kind).toBe('pending_verification');
  expect(inbox).toHaveLength(2);
  expect((await verify(item)).join.kind).toBe('invalid_proof');
  const code = inbox[1].text.match(/code is (\d{8})/)[1];
  expect((await service.completeProof(null, item.result.join.intentId, { ...item.verify, requestId: uuid(), code })).join.kind).toBe('confirmed');
});

test('HTTP options are unavailable while disabled and enabled responses are private-cache only', async () => {
  const http = request(strapi.server.httpServer);
  process.env.PARTICIPATION_ENABLED = 'false';
  try { await http.get('/api/participation/options').expect(404); }
  finally { process.env.PARTICIPATION_ENABLED = 'true'; }
  const result = await http.get('/api/participation/options').expect(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body.data.required).toContain('phoneRaw');
  await http.get('/api/participation/me/profile').expect(401);
  await http.get('/api/participation/me/profile').set('Authorization', 'Bearer invalid').expect(401);
});

test('HTTP guest completion exposes one minimal post-commit session and safe replay, profile and Schedule reads', async () => {
  const http = request(strapi.server.httpServer);
  const selected = await event(); const values = draft(); const browserSecret = secret();
  const pending = await http.post('/api/volunteer-days/' + selected.documentId + '/joins').send({ requestId: uuid(), browserSecret, draft: values }).expect(202);
  expect(pending.headers['cache-control']).toBe('no-store');
  expect(pending.body.data.kind).toBe('pending_verification');
  expect(JSON.stringify(pending.body)).not.toContain(values.emailRaw);
  const verifyBody = { requestId: uuid(), browserSecret, code: inbox[inbox.length - 1].text.match(/code is (\d{8})/)[1] };
  const done = await http.post('/api/join-intents/' + pending.body.data.intentId + '/verify').send(verifyBody).expect(200);
  expect(done.body.data.join.kind).toBe('confirmed');
  const session = done.body.data.session;
  expect(Object.keys(session.user).sort()).toEqual(['id', 'role', 'username']);
  expect(Object.keys(session.user.role).sort()).toEqual(['id', 'name', 'type']);
  expect(session.user.role.type).toBe('authenticated');
  expect(done.body.data).not.toHaveProperty('sessionActorId');
  expect(JSON.stringify(done.body)).not.toContain(values.emailRaw);
  const replay = await http.post('/api/join-intents/' + pending.body.data.intentId + '/verify').send(verifyBody).expect(200);
  expect(replay.body.data).not.toHaveProperty('session');
  expect(replay.body.data.join.receipt).toEqual(done.body.data.join.receipt);
  const profile = await http.get('/api/participation/me/profile').auth(session.jwt, { type: 'bearer' }).expect(200);
  expect(profile.body.data).toMatchObject({ emailRaw: values.emailRaw, phoneRaw: values.phoneRaw, proofStatus: { email: true, phone: false } });
  expect(profile.body.data).not.toHaveProperty('accessRequestRaw');
  const own = await http.get('/api/volunteer-days/' + selected.documentId + '/joins/me').auth(session.jwt, { type: 'bearer' }).expect(200);
  expect(own.body.data).toEqual(done.body.data.join.receipt);
  const list = await http.get('/api/participation/me?page=1&pageSize=1').auth(session.jwt, { type: 'bearer' }).expect(200);
  expect(list.body.data).toEqual([done.body.data.join.receipt]);
  expect(list.body.meta.pagination.total).toBe(1);
  expect(JSON.stringify(list.body)).not.toContain(values.emailRaw);
});

test('HTTP rejects supplied actor identity and unsupported filters without creating an intent', async () => {
  const http = request(strapi.server.httpServer); const selected = await event(); const before = await query('join-intent').count();
  await http.post('/api/volunteer-days/' + selected.documentId + '/joins').send({ requestId: uuid(), browserSecret: secret(), draft: draft(), userId: 1 }).expect(422);
  expect(await query('join-intent').count()).toBe(before);
  await http.get('/api/participation/me?filters[userId]=1').expect(422);
});

async function loginAfterCooldown(emailRaw) {
  await elapsedDestination(strapi, tools, emailRaw);
  const body = { requestId: uuid(), browserSecret: secret(), emailRaw };
  const result = await request(strapi.server.httpServer).post('/api/auth/email-login/request').send(body).expect(202);
  await strapi.service('api::auth.email-login').drain();
  return { body, result: result.body.data };
}

test('email login has the same public shape for known and unknown addresses without creating accounts', async () => {
  const item = await pendingAfterCooldown(); await verify(item); inbox = [];
  const before = await users().count();
  const known = await loginAfterCooldown(item.body.draft.emailRaw);
  const unknown = await loginAfterCooldown('Unknown.' + uuid() + '@example.com');
  expect(Object.keys(known.result).sort()).toEqual(['expiresAt', 'kind', 'proofId', 'resendAfterSeconds']);
  expect(Object.keys(unknown.result).sort()).toEqual(Object.keys(known.result).sort());
  expect(known.result.kind).toBe(unknown.result.kind);
  expect(known.result.resendAfterSeconds).toBe(60); expect(unknown.result.resendAfterSeconds).toBe(60);
  expect(known.result.proofId).toMatch(/^[a-f0-9]{64}$/); expect(unknown.result.proofId).toMatch(/^[a-f0-9]{64}$/);
  expect(inbox).toHaveLength(1);
  expect(await users().count()).toBe(before);
});

test('email login recovers a lost first session without a future event and never replays its session', async () => {
  const item = await pendingAfterCooldown(); const joined = await verify(item);
  await strapi.documents(eventUid).update({ documentId: item.selected.documentId, status: 'published', data: { canceled: true } });
  inbox = [];
  const value = await loginAfterCooldown(item.body.draft.emailRaw);
  const body = { requestId: uuid(), proofId: value.result.proofId, browserSecret: value.body.browserSecret, code: inbox[0].text.match(/code is (\d{8})/)[1] };
  const http = request(strapi.server.httpServer);
  await http.post('/api/auth/email-login/verify').send({ ...body, browserSecret: secret() }).expect(400);
  const result = await http.post('/api/auth/email-login/verify').send(body).expect(200);
  expect(result.body.data.session.user.id).toBe(joined.sessionActorId);
  expect(Object.keys(result.body.data.session.user).sort()).toEqual(['id', 'role', 'username']);
  expect(JSON.stringify(result.body)).not.toContain(item.body.draft.emailRaw);
  await http.post('/api/auth/email-login/verify').send(body).expect(400);
  const profile = await http.get('/api/participation/me/profile').auth(result.body.data.session.jwt, { type: 'bearer' }).expect(200);
  expect(profile.body.data.emailRaw).toBe(item.body.draft.emailRaw);
});

test('capped login requests keep the pending shape without adding a proof or sending email', async () => {
  const item = await pendingAfterCooldown(); await verify(item); inbox = [];
  const requests = strapi.db.metadata.get('api::participation.participation-request').tableName;
  const source = await strapi.db.connection(requests).where({ operation: 'identity:request:join_identity' }).whereNotNull('rate_destination_key').orderBy('id', 'desc').first();
  for (let index = 0; index < 4; index++) {
    const row = { ...source }; delete row.id;
    row.document_id = secret().slice(0, 24); row.request_id = uuid();
    await strapi.db.connection(requests).insert(row);
  }
  const before = await query('contact-proof').count();
  const capped = await loginAfterCooldown(item.body.draft.emailRaw);
  expect(capped.result).toMatchObject({ kind: 'pending_verification', resendAfterSeconds: 60 });
  expect(capped.result.proofId).toMatch(/^[a-f0-9]{64}$/);
  expect(await query('contact-proof').count()).toBe(before); expect(inbox).toEqual([]);
});

test('revoked email ownership cannot mint a login session after code delivery', async () => {
  const item = await pendingAfterCooldown(); const joined = await verify(item); inbox = [];
  const value = await loginAfterCooldown(item.body.draft.emailRaw);
  const code = inbox[0].text.match(/code is (\d{8})/)[1];
  await query('verified-contact').updateMany({ where: { userId: joined.sessionActorId }, data: { revokedAt: new Date().toISOString() } });
  await request(strapi.server.httpServer).post('/api/auth/email-login/verify').send({ requestId: uuid(), browserSecret: value.body.browserSecret, proofId: value.result.proofId, code }).expect(400);
});

test('enabled registration blocks unverified legacy email writers while verified construction still works', async () => {
  const before = await users().count();
  await expect(users().create({ data: { username: uuid(), email: 'Unsafe.' + uuid() + '@example.com', provider: 'local' } })).rejects.toMatchObject({ name: 'ValidationError' });
  expect(await users().count()).toBe(before);
  const item = await pendingAfterCooldown(); const result = await verify(item);
  const user = await users().findOne({ where: { id: result.sessionActorId } });
  await expect(users().update({ where: { id: user.id }, data: { email: 'Unsafe.' + uuid() + '@example.com' } })).rejects.toMatchObject({ name: 'ValidationError' });
  await expect(users().updateMany({ where: { id: user.id }, data: { email: null } })).rejects.toMatchObject({ name: 'ValidationError' });
  await expect(users().createMany({ data: [{ username: uuid(), email: 'Unsafe.' + uuid() + '@example.com', provider: 'local' }] })).rejects.toMatchObject({ name: 'ValidationError' });
  expect((await users().findOne({ where: { id: user.id } })).email).toBe(user.email);
  expect(strapi.service('api::auth.join-identity').legacyEmailWritePermitted()).toBe(false);
  await request(strapi.server.httpServer).post('/api/auth/local/register').send({ username: uuid(), email: 'Unsafe.' + uuid() + '@example.com', password: 'Synthetic-only-password-123' }).expect(400);
});

test('verified constructor permission does not leak to another concurrent legacy email write', async () => {
  const item = await pendingAfterCooldown();
  const native = strapi.plugin('users-permissions').service('user');
  const original = native.add;
  let reached; let release;
  const entered = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  native.add = async function (data) { reached(); await resume; return original.call(this, data); };
  const completing = verify(item); completing.catch(() => {});
  try {
    await entered;
    expect(strapi.service('api::auth.join-identity').legacyEmailWritePermitted()).toBe(false);
    await expect(users().create({ data: { username: uuid(), email: 'Unsafe.' + uuid() + '@example.com', provider: 'local' } })).rejects.toMatchObject({ name: 'ValidationError' });
  } finally { release(); await completing; native.add = original; }
});

test('legacy confirmation import is idempotent across document versions without attendance, consent or newsletter enrollment', async () => {
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const user = await users().create({ data: { username: uuid(), role: role.id, provider: 'local', confirmed: true, blocked: false } });
  const selected = await event();
  const rows = await strapi.db.query(eventUid).findMany({ where: { documentId: selected.documentId }, select: ['id'] });
  for (const row of rows) await strapi.db.query(eventUid).update({ where: { id: row.id }, data: { confirmed: [user.id] } });
  const first = await service.importLegacyConfirmed();
  expect(first.created).toBe(1);
  expect((await service.importLegacyConfirmed()).created).toBe(0);
  const saved = await query('participation').findOne({ where: { userId: user.id, eventDocumentId: selected.documentId } });
  expect(saved).toMatchObject({ rsvpState: 'confirmed', checkedInAt: null, followupState: 'not_planned', joinSnapshotJson: { source: 'legacy_import', rsvpTimeKnown: false } });
  expect(saved.rsvpedAt).toBeTruthy();
  expect((await service.ownReceipt(user.id, selected.documentId)).rsvpedAt).toBeNull();
  expect(await query('consent-receipt').count({ where: { userId: user.id } })).toBe(0);
  expect(await strapi.db.query('api::newsletter.newsletter-subscription').count({ where: { userId: user.id } })).toBe(0);
  expect(await privateProfile(user.id)).toBeNull(); expect(inbox).toEqual([]);
});

test('core RSVP filter uses canonical state before pagination and projects only self plus the real count', async () => {
  await permit('authenticated', 'api::volunteer-day.volunteer-day.find');
  const item = await pendingAfterCooldown(); const registered = await verify(item); const actorId = registered.sessionActorId;
  const token = await strapi.plugin('users-permissions').service('jwt').issue({ id: actorId });
  const other = await users().create({ data: { username: uuid(), provider: 'local', blocked: false } });
  await strapi.db.query(eventUid).update({ where: { id: item.selected.id }, data: { confirmed: [other.id] } });
  const stale = await event();
  await strapi.db.query(eventUid).update({ where: { id: stale.id }, data: { confirmed: [actorId] } });
  await query('participation').create({ data: { receiptId: secret(), eventDocumentId: stale.documentId, gardenDocumentId: garden.documentId, userId: actorId, rsvpState: 'cancelled', rsvpedAt: new Date().toISOString(), joinSnapshotJson: {} } });
  const http = request(strapi.server.httpServer);
  const result = await http.get('/api/volunteer-days?filters[confirmed][id][$eq]=' + actorId + '&status=published&pagination[pageSize]=1&populate[confirmed]=true').auth(token, { type: 'bearer' }).expect(200);
  expect(result.body.meta.pagination.total).toBe(1);
  expect(result.body.data.map(row => row.documentId)).toEqual([item.selected.documentId]);
  expect(result.body.data[0].confirmed).toEqual([{ id: actorId }]); expect(result.body.data[0].confirmedCount).toBe(1);
  await http.get('/api/volunteer-days?filters[confirmed][id][$eq]=' + other.id).auth(token, { type: 'bearer' }).expect(400);
  const anonymous = await http.get('/api/volunteer-days/by-id/' + item.selected.documentId).expect(200);
  expect(anonymous.body.data.confirmed).toEqual([]); expect(anonymous.body.data.confirmedCount).toBe(1);
  expect(anonymous.headers['cache-control']).toBe('no-store');
});

test('legacy numeric self adapter confirms through one authority with no SMS or relation dual write', async () => {
  await permit('authenticated', 'api::volunteer-day.volunteer-day.rsvpEvent');
  await permit('public', 'api::volunteer-day.volunteer-day.rsvpEvent');
  const item = await pendingAfterCooldown(); const registered = await verify(item); const actorId = registered.sessionActorId;
  const token = await strapi.plugin('users-permissions').service('jwt').issue({ id: actorId });
  const selected = await event(); const http = request(strapi.server.httpServer);
  const sms = jest.spyOn(strapi.service('api::sms.sms'), 'handleSms');
  try {
    await http.post('/api/volunteer-days/rsvp/' + selected.id).send({ data: { phoneNumber: '5105550123' } }).expect(401);
    await http.post('/api/volunteer-days/rsvp/' + selected.id).auth(token, { type: 'bearer' }).send({ data: { userId: actorId + 100000 } }).expect(409);
    const confirmed = await http.post('/api/volunteer-days/rsvp/' + selected.id).auth(token, { type: 'bearer' }).send({ data: { userId: actorId } }).expect(200);
    expect(confirmed.body.data.confirmed).toEqual([{ id: actorId }]); expect(confirmed.body.data.confirmedCount).toBe(1);
    const original = await strapi.db.query(eventUid).findOne({ where: { id: selected.id }, populate: { confirmed: { select: ['id'] } } });
    expect(original.confirmed).toEqual([]);
    await http.post('/api/volunteer-days/rsvp/' + selected.id).auth(token, { type: 'bearer' }).send({ data: { userId: actorId } }).expect(200);
    expect(await query('participation').count({ where: { eventDocumentId: selected.documentId, userId: actorId } })).toBe(1);
    expect(sms).not.toHaveBeenCalled();
  } finally { sms.mockRestore(); }
});

test('core confirmed writes are rejected and nested projection keeps separate campaign confirmation state', async () => {
  const selected = await event();
  await expect(strapi.documents(eventUid).update({ documentId: selected.documentId, data: { confirmed: [] } })).rejects.toMatchObject({ name: 'ValidationError' });
  const cleaned = service.stripConfirmedPopulate('api::project.project', { related_events: { populate: { confirmed: true, hero_image: true } } });
  expect(cleaned.related_events.populate).toEqual({ hero_image: true });
  expect(service.stripConfirmedPopulate('api::sms-campaign.sms-campaign', { confirmed: true })).toEqual({ confirmed: true });
  expect(() => service.stripConfirmedPopulate(eventUid, ['__proto__.confirmed'])).toThrow('Unsupported population');
});

test('anonymous hidden and draft event details are404 under the new authority', async () => {
  const hidden = await event({ accessibility: 'Garden Members' });
  const draft = await strapi.documents(eventUid).create({ data: { title: 'Synthetic unpublished workday', garden: garden.documentId, accessibility: 'Public', startDatetime: new Date(Date.now() + 86400000).toISOString() } });
  const http = request(strapi.server.httpServer);
  await http.get('/api/volunteer-days/by-id/' + hidden.documentId).expect(404);
  await http.get('/api/volunteer-days/by-id/' + draft.documentId).expect(404);
  const role = await permit('authenticated', 'api::volunteer-day.volunteer-day.find');
  await permit('authenticated', 'api::volunteer-day.volunteer-day.findOne');
  const stranger = await users().create({ data: { username: uuid(), provider: 'local', role: role.id, blocked: false } });
  const token = await strapi.plugin('users-permissions').service('jwt').issue({ id: stranger.id });
  await http.get('/api/volunteer-days/' + hidden.documentId).auth(token, { type: 'bearer' }).expect(404);
  await http.get('/api/volunteer-days/' + draft.documentId + '?status=draft').auth(token, { type: 'bearer' }).expect(404);
  const listed = await http.get('/api/volunteer-days?filters[documentId][$in][0]=' + hidden.documentId + '&filters[documentId][$in][1]=' + draft.documentId).auth(token, { type: 'bearer' }).expect(200);
  expect(listed.body.data).toEqual([]); expect(listed.body.meta.pagination.total).toBe(0);
});

test('a document-level garden manager retains private draft event access', async () => {
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const manager = await users().create({ data: { username: uuid(), role: role.id, provider: 'local', blocked: false } });
  const versions = await strapi.db.query('api::garden.garden').findMany({ where: { documentId: garden.documentId }, select: ['id', 'publishedAt'] });
  const draftGarden = versions.find(row => !row.publishedAt);
  await strapi.db.query('api::garden.garden').update({ where: { id: draftGarden.id }, data: { managers: [manager.id] } });
  const selected = await strapi.documents(eventUid).create({ data: { title: 'Synthetic private planning event', garden: garden.documentId, accessibility: 'Garden Members', startDatetime: new Date(Date.now() + 86400000).toISOString() } });
  const token = await strapi.plugin('users-permissions').service('jwt').issue({ id: manager.id });
  const http = request(strapi.server.httpServer);
  await http.get('/api/volunteer-days/by-id/' + selected.documentId).expect(404);
  const result = await http.get('/api/volunteer-days/by-id/' + selected.documentId).auth(token, { type: 'bearer' }).expect(200);
  expect(result.body.data.documentId).toBe(selected.documentId);
  await permit('authenticated', 'api::volunteer-day.volunteer-day.findOne');
  const core = await http.get('/api/volunteer-days/' + selected.documentId + '?status=draft').auth(token, { type: 'bearer' }).expect(200);
  expect(core.body.data.documentId).toBe(selected.documentId);
});

test('linked project events use canonical counts and project interest never creates a typed-email account', async () => {
  await permit('authenticated', 'api::project.project.findOne');
  await permit('authenticated', 'api::volunteer-day.volunteer-day.find');
  const item = await pendingAfterCooldown(); const registered = await verify(item);
  const token = await strapi.plugin('users-permissions').service('jwt').issue({ id: registered.sessionActorId });
  const project = await strapi.documents('api::project.project').create({ status: 'published', data: { title: 'Synthetic shared project', short_description: 'A shared garden project for this test.', slug: 'synthetic-' + uuid(), garden: garden.documentId, review_status: 'APPROVED', related_events: [item.selected.documentId] } });
  const http = request(strapi.server.httpServer);
  const result = await http.get('/api/projects/' + project.documentId + '?status=published&populate[related_events][populate][confirmed]=true').auth(token, { type: 'bearer' }).expect(200);
  expect(result.body.data.related_events[0]).toMatchObject({ documentId: item.selected.documentId, confirmedCount: 1, confirmed: [{ id: registered.sessionActorId }] });
  await http.get('/api/projects/' + project.documentId + '?populate[related_events][filters][confirmed][id][$eq]=999').auth(token, { type: 'bearer' }).expect(400);
  await permit('authenticated', 'api::project.project.find');
  await http.get('/api/projects?filters[related_events][confirmed][id][$eq]=999').auth(token, { type: 'bearer' }).expect(400);
  const before = await users().count();
  await http.post('/api/projects/' + project.id + '/express-interest').send({ email: 'Unverified.' + uuid() + '@example.com' }).expect(401);
  const interested = await http.post('/api/projects/' + project.id + '/express-interest').auth(token, { type: 'bearer' }).send({}).expect(200);
  expect(interested.body).toEqual({ count: 1, isInterested: true });
  expect(await users().count()).toBe(before);
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const other = await users().create({ data: { username: uuid(), provider: 'local', role: role.id, blocked: false } });
  const otherToken = await strapi.plugin('users-permissions').service('jwt').issue({ id: other.id });
  await Promise.all([
    http.post('/api/projects/' + project.id + '/express-interest').auth(token, { type: 'bearer' }).send({}).expect(200),
    http.post('/api/projects/' + project.id + '/express-interest').auth(otherToken, { type: 'bearer' }).send({}).expect(200),
  ]);
  const saved = await strapi.db.query('api::project.project').findOne({ where: { id: project.id }, populate: ['interested'] });
  expect(saved.interested.map(user => user.id).sort()).toEqual([registered.sessionActorId, other.id].sort());
});
