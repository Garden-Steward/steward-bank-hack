'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');

const uuid = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString('hex');
const MASTER = secret();
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
async function pending({ selected = null, values = null, actorId = null } = {}) {
  if (!selected) selected = await event();
  if (!values) values = draft();
  const body = { requestId: uuid(), browserSecret: secret(), draft: values };
  const result = await service.submit(actorId, selected.documentId, body, '127.0.0.1');
  return { selected, body, result, verify: { requestId: uuid(), browserSecret: body.browserSecret, code: inbox[inbox.length - 1].text.match(/code is (\d{8})/)[1] } };
}
const verify = (item, actorId = null) => service.completeProof(actorId, item.result.join.intentId, item.verify);
const privateProfile = id => query('join-profile').findOne({ where: { userId: id } });

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
  const item = await pending();
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
  const item = await pending();
  const first = await verify(item);
  const replay = await verify(item);
  expect(replay.join).toEqual(first.join);
  expect(replay).not.toHaveProperty('sessionActorId');
  expect(await query('participation').count({ where: { userId: first.sessionActorId, eventDocumentId: item.selected.documentId } })).toBe(1);
  expect((await service.submit(null, item.selected.documentId, item.body, '127.0.0.1')).join.kind).toBe('already_confirmed');
  await expect(service.completeProof(null, item.result.join.intentId, { ...item.verify, code: '00000000' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
});

test('wrong-code retry with one UUID commits one guess and a different UUID commits the next guess', async () => {
  const item = await pending();
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
  const item = await pending();
  expect((await service.completeProof(null, item.result.join.intentId, { ...item.verify, browserSecret: secret() })).join.kind).toBe('invalid_proof');
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).attempts).toBe(0);
});

test('new UUID guesses after the five-attempt cap do not grow the verification ledger', async () => {
  const item = await pending();
  const wrong = item.verify.code.slice(0, 7) + String((Number(item.verify.code[7]) + 1) % 10);
  for (let index = 0; index < 8; index++) await service.completeProof(null, item.result.join.intentId, { ...item.verify, requestId: uuid(), code: wrong });
  const requests = strapi.db.metadata.get('api::participation.participation-request').tableName;
  const count = await strapi.db.connection(requests).where({ operation: 'participation:verify:' + item.result.join.intentId }).count('* as count').first();
  expect(Number(count.count)).toBe(5);
});

test('authenticated exact email owner joins directly and profile conflict preserves a valid RSVP snapshot', async () => {
  const item = await pending(); const first = await verify(item);
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
  const item = await pending(); const before = await users().count();
  await strapi.documents(eventUid).update({ documentId: item.selected.documentId, status: 'published', data: { canceled: true } });
  await expect(verify(item)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE', status: 409 });
  expect(await users().count()).toBe(before);
  expect((await query('contact-proof').findOne({ where: { receiptId: item.result.join.proofId } })).consumedAt).toBeNull();
});

test('legacy email proof requires exact signed-in actor resume and does not create another account', async () => {
  const email = 'Legacy.' + uuid() + '@example.com';
  const legacy = await users().create({ data: { username: uuid(), email, provider: 'local', confirmed: true, blocked: false } });
  const other = await users().create({ data: { username: uuid(), provider: 'local', confirmed: true, blocked: false } });
  const item = await pending({ values: draft({ emailRaw: email }) }); const before = await users().count();
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
  const item = await pending(); const result = await verify(item); const userId = result.sessionActorId;
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
  const item = await pending(); const result = await verify(item);
  const other = await users().create({ data: { username: uuid(), provider: 'local', blocked: false } });
  expect(await service.ownReceipt(other.id, item.selected.documentId)).toBeNull();
  expect(await service.ownReceipt(result.sessionActorId, item.selected.documentId)).toEqual(result.join.receipt);
});

test('accepted pending submit replay reuses its proof and changed raw input conflicts', async () => {
  const item = await pending();
  const first = await service.submit(null, item.selected.documentId, item.body, '127.0.0.1');
  expect(first).toEqual(item.result); expect(inbox).toHaveLength(1);
  await expect(service.submit(null, item.selected.documentId, { ...item.body, draft: { ...item.body.draft, preferredNameRaw: 'Different' } }, '127.0.0.1')).rejects.toMatchObject({ code: 'REQUEST_CONFLICT', status: 409 });
});

test('resend cooldown preserves its original generation and later resend requires the new code', async () => {
  const item = await pending();
  const body = { requestId: uuid(), browserSecret: item.body.browserSecret };
  await expect(service.resend(item.result.join.intentId, body, '127.0.0.1')).rejects.toMatchObject({ code: 'IDENTITY_COOLDOWN', status: 400 });
  const proofs = strapi.db.metadata.get('api::participation.contact-proof').tableName;
  await strapi.db.connection(proofs).where({ receipt_id: item.result.join.proofId }).update({ expires_at: new Date(Date.now() + 600000 - 61000) });
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
