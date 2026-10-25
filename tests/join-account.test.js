'use strict';

const crypto = require('node:crypto');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');
const createCrypto = require('../src/api/auth/join-identity-internal/proof-crypto');
const elapsedDestination = require('./helpers/identity-time');

const secret = () => crypto.randomBytes(32).toString('hex');
const uuid = () => crypto.randomUUID();
const MASTER = secret();
const tools = createCrypto(MASTER);
let previousKey;
let owner;
let inbox;
let originalSend;
const query = name => strapi.db.query('api::participation.' + name);
const userQuery = () => strapi.db.query('plugin::users-permissions.user');

async function pendingAfterCooldown({ rawValue = '  Person.' + uuid() + '@EXAMPLE.COM  ', actorId = null } = {}) {
  await elapsedDestination(strapi, tools, rawValue);
  const browserSecret = secret();
  const requestId = uuid();
  const intent = await query('join-intent').create({ data: {
    receiptId: secret(), eventDocumentId: secret(), browserSecretHash: tools.browserHash(browserSecret), requestId,
    requestHmac: secret(), draftJson: { preferredNameRaw: '  Person  ', emailRaw: rawValue, phoneRaw: '  (510) 555-0123  ' },
    boundActorId: actorId, expiresAt: new Date(Date.now() + 3600000).toISOString(),
  } });
  const command = { purpose: 'join_identity', intentId: intent.id, browserSecret, requestId, rawValue, socketPeer: '127.0.0.1' };
  const result = await owner.withTransaction(trx => owner.requestEmailProof(trx, command));
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const code = inbox[inbox.length - 1].text.match(/code is (\d{8})/)[1];
  return { intent, command, result, submission: { purpose: 'join_identity', intentId: intent.id, browserSecret, proofId: result.public.proofId, code } };
}
async function complete(item, finish) {
  return owner.withTransaction(async trx => {
    const verified = await owner.consumeEmailProof(trx, item.submission);
    if (verified.kind !== 'verified') return verified;
    const account = await owner.resolveFreshJoinAccount(trx, { proofId: verified.proof.id });
    if (finish) await finish(trx, account);
    return account;
  });
}
async function legacy(email, extra = {}) {
  return userQuery().create({ data: { username: uuid(), email, provider: 'local', confirmed: true, blocked: false, ...extra } });
}

beforeAll(async () => {
  previousKey = process.env.PARTICIPATION_IDENTITY_KEY;
  process.env.PARTICIPATION_IDENTITY_KEY = MASTER;
  await setupStrapi();
  owner = strapi.service('api::auth.join-identity');
  originalSend = strapi.plugin('email').service('email').send;
  strapi.plugin('email').service('email').send = async options => {
    expect(strapi.db.inTransaction()).toBe(false);
    inbox.push(options);
    return { simulated: true };
  };
});
beforeEach(() => { inbox = []; });
afterAll(async () => {
  strapi.plugin('email').service('email').send = originalSend;
  await cleanupStrapi();
  if (previousKey === undefined) delete process.env.PARTICIPATION_IDENTITY_KEY;
  else process.env.PARTICIPATION_IDENTITY_KEY = previousKey;
});

test('fresh join proof creates a minimal verified account, mapping and automatic newsletter in one transaction', async () => {
  const item = await pendingAfterCooldown();
  const before = await userQuery().count();
  const result = await complete(item);
  expect(result).toMatchObject({ kind: 'account', created: true, newsletter: 'subscribed' });
  expect(await userQuery().count()).toBe(before + 1);
  const user = await userQuery().findOne({ where: { id: result.userId }, populate: ['role', 'activeGarden', 'gardens'] });
  expect(user).toMatchObject({ provider: 'local', confirmed: true, blocked: false, email: item.command.rawValue.trim().replace('@EXAMPLE.COM', '@example.com'), role: { type: 'authenticated' } });
  expect(user.username).toMatch(/^garden_[a-f0-9]{48}$/);
  expect(user.password).toMatch(/^\$2[aby]\$/);
  expect(user.activeGarden).toBeNull();
  expect(user.gardens).toEqual([]);
  expect(user.firstName).toBeFalsy(); expect(user.lastName).toBeFalsy(); expect(user.phoneNumber).toBeFalsy();
  expect(await query('verified-contact').findOne({ where: { id: result.verifiedContactId } })).toMatchObject({ userId: user.id, channel: 'email' });
  expect(await query('join-intent').findOne({ where: { id: item.intent.id } })).toMatchObject({ boundActorId: user.id, draftJson: { emailRaw: item.command.rawValue, phoneRaw: '  (510) 555-0123  ' } });
  expect(inbox).toHaveLength(1);
});

test('only a proof freshly consumed in the exact owner transaction can resolve an account', async () => {
  const item = await pendingAfterCooldown();
  const proof = await query('contact-proof').findOne({ where: { receiptId: item.result.public.proofId } });
  await expect(owner.resolveFreshJoinAccount({}, { proofId: proof.id })).rejects.toMatchObject({ code: 'IDENTITY_TRANSACTION_REQUIRED' });
  await expect(owner.withTransaction(trx => owner.resolveFreshJoinAccount(trx, { proofId: proof.id }))).rejects.toMatchObject({ code: 'IDENTITY_FRESH_PROOF_REQUIRED' });
  expect((await owner.withTransaction(trx => owner.consumeEmailProof(trx, item.submission))).kind).toBe('verified');
  const before = await userQuery().count();
  await expect(owner.withTransaction(trx => owner.resolveFreshJoinAccount(trx, { proofId: proof.id }))).rejects.toMatchObject({ code: 'IDENTITY_FRESH_PROOF_REQUIRED' });
  expect(await userQuery().count()).toBe(before);
});

test('concurrent completion consumes once and creates one account and one registry owner', async () => {
  const item = await pendingAfterCooldown();
  const before = await userQuery().count();
  const results = await Promise.all([complete(item), complete(item)]);
  expect(results.map(result => result.kind).sort()).toEqual(['account', 'invalid_proof']);
  expect(await userQuery().count()).toBe(before + 1);
  expect(await query('verified-contact').count({ where: { proofId: item.result.delivery.proofId } })).toBe(1);
});

test('a final write failure rolls back the proof, account, mapping, intent and newsletter together', async () => {
  const item = await pendingAfterCooldown();
  const before = await userQuery().count();
  const newsletter = strapi.db.query('api::newsletter.newsletter-subscription');
  const preferences = strapi.db.query('api::newsletter.newsletter-preference-event');
  const beforeSubscriptions = await newsletter.count();
  const beforePreferences = await preferences.count();
  await expect(complete(item, async () => { throw new Error('Synthetic final join write failure'); })).rejects.toThrow('Synthetic final join write failure');
  expect(await userQuery().count()).toBe(before);
  expect(await newsletter.count()).toBe(beforeSubscriptions);
  expect(await preferences.count()).toBe(beforePreferences);
  expect(await query('verified-contact').count({ where: { proofId: item.result.delivery.proofId } })).toBe(0);
  expect(await query('contact-proof').findOne({ where: { id: item.result.delivery.proofId } })).toMatchObject({ consumedAt: null });
  expect(await query('join-intent').findOne({ where: { id: item.intent.id } })).toMatchObject({ boundActorId: null, state: 'pending' });
  expect((await complete(item)).created).toBe(true);
});

test('an exact legacy email requires its original signed-in actor and browser before binding', async () => {
  const email = 'Legacy.' + uuid() + '@example.com';
  const user = await legacy('\t' + email.replace('@example.com', '@EXAMPLE.COM') + ' ');
  const item = await pendingAfterCooldown({ rawValue: '  ' + email + '  ' });
  const before = await userQuery().count();
  expect(await complete(item)).toEqual({ kind: 'sign_in_required' });
  expect(await userQuery().count()).toBe(before);
  expect(await query('verified-contact').count({ where: { userId: user.id } })).toBe(0);
  expect(await query('join-intent').findOne({ where: { id: item.intent.id } })).toMatchObject({ state: 'sign_in_required', boundLegacyUserId: user.id, boundActorId: null });
  const command = { intentId: item.intent.id, actorId: user.id, browserSecret: item.command.browserSecret };
  for (const changed of [{ actorId: user.id + 100000 }, { browserSecret: secret() }]) {
    await expect(owner.withTransaction(trx => owner.resumeJoinAccount(trx, { ...command, ...changed }))).rejects.toMatchObject({ code: 'IDENTITY_ACCOUNT_CHANGED' });
  }
  expect(await owner.withTransaction(trx => owner.resumeJoinAccount(trx, command))).toMatchObject({ kind: 'account', userId: user.id, created: false, newsletter: 'subscribed' });
  expect(await userQuery().count()).toBe(before);
  expect(inbox).toHaveLength(1);
});

test.each(['duplicate', 'local_case', 'blocked'])('legacy collision or ineligible account never chooses an arbitrary owner (%s)', async kind => {
  const email = 'Legacy.' + uuid() + '@example.com';
  if (kind === 'local_case') await legacy(email.toLowerCase());
  else await legacy(email, { blocked: kind === 'blocked' });
  if (kind === 'duplicate') await legacy(email.replace('@example.com', '@EXAMPLE.COM'));
  const item = await pendingAfterCooldown({ rawValue: email });
  const before = await userQuery().count();
  let expected = 'IDENTITY_COLLISION';
  if (kind === 'blocked') expected = 'IDENTITY_ACCOUNT_UNAVAILABLE';
  await expect(complete(item)).rejects.toMatchObject({ code: expected });
  expect(await userQuery().count()).toBe(before);
  expect((await query('contact-proof').findOne({ where: { id: item.result.delivery.proofId } })).consumedAt).toBeNull();
});

test('an authenticated bound actor cannot use a different account email to change actors', async () => {
  const first = await complete(await pendingAfterCooldown());
  const second = await complete(await pendingAfterCooldown());
  const user = await userQuery().findOne({ where: { id: first.userId } });
  const item = await pendingAfterCooldown({ rawValue: user.email, actorId: second.userId });
  await expect(complete(item)).rejects.toMatchObject({ code: 'IDENTITY_ACCOUNT_CHANGED' });
});

test('plus aliases and dots do not merge a new account into a legacy account', async () => {
  const local = 'Person.' + uuid();
  await legacy(local + '+garden@example.com');
  const item = await pendingAfterCooldown({ rawValue: local + '@example.com' });
  const result = await complete(item);
  expect(result.created).toBe(true);
});

test('a returning registry owner retains an explicit newsletter unsubscribe', async () => {
  const item = await pendingAfterCooldown();
  const account = await complete(item);
  const newsletter = strapi.service('api::newsletter.newsletter');
  await newsletter.setAccountPreference({ userId: account.userId, expectedRevision: 1, requestId: uuid(), preference: 'unsubscribed' });
  const before = await userQuery().count();
  const returning = await complete(await pendingAfterCooldown({ rawValue: item.command.rawValue }));
  expect(returning).toMatchObject({ kind: 'account', userId: account.userId, created: false, newsletter: 'unsubscribed' });
  expect(await userQuery().count()).toBe(before);
});

test('a fresh proof claim cannot be reused twice within its original transaction', async () => {
  const item = await pendingAfterCooldown();
  const before = await userQuery().count();
  await expect(complete(item, trx => owner.resolveFreshJoinAccount(trx, { proofId: item.result.delivery.proofId }))).rejects.toMatchObject({ code: 'IDENTITY_FRESH_PROOF_REQUIRED' });
  expect(await userQuery().count()).toBe(before);
  expect((await query('contact-proof').findOne({ where: { id: item.result.delivery.proofId } })).consumedAt).toBeNull();
});

test('overlapping resolvers within one transaction admit the fresh claim exactly once', async () => {
  const first = await pendingAfterCooldown();
  const account = await complete(first);
  const returning = await pendingAfterCooldown({ rawValue: first.command.rawValue });
  const results = await owner.withTransaction(async trx => {
    const verified = await owner.consumeEmailProof(trx, returning.submission);
    expect(verified.kind).toBe('verified');
    return Promise.allSettled([
      owner.resolveFreshJoinAccount(trx, { proofId: verified.proof.id }),
      owner.resolveFreshJoinAccount(trx, { proofId: verified.proof.id }),
    ]);
  });
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'fulfilled').value.userId).toBe(account.userId);
  expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'IDENTITY_FRESH_PROOF_REQUIRED' });
});

test('a blocked registry owner cannot create a replacement account through a join proof', async () => {
  const first = await pendingAfterCooldown();
  const account = await complete(first);
  const item = await pendingAfterCooldown({ rawValue: first.command.rawValue });
  await userQuery().update({ where: { id: account.userId }, data: { blocked: true } });
  const before = await userQuery().count();
  await expect(complete(item)).rejects.toMatchObject({ code: 'IDENTITY_ACCOUNT_UNAVAILABLE' });
  expect(await userQuery().count()).toBe(before);
});

test('a bound signed-in actor may prove a new contact without replacing legacy credentials or creating another account', async () => {
  const user = await legacy('Original.' + uuid() + '@example.com');
  const item = await pendingAfterCooldown({ actorId: user.id });
  const before = await userQuery().count();
  expect(await complete(item)).toMatchObject({ kind: 'account', userId: user.id, created: false });
  expect(await userQuery().count()).toBe(before);
  expect((await userQuery().findOne({ where: { id: user.id } })).email).toBe(user.email);
});

test('automatic first enrollment preserves an existing destination complaint suppression', async () => {
  const item = await pendingAfterCooldown();
  const proof = await query('contact-proof').findOne({ where: { id: item.result.delivery.proofId } });
  await strapi.service('api::newsletter.newsletter').suppressDestination({ derivationVersion: 1, destinationKey: proof.destinationKey, reason: 'complaint', sourceKey: uuid() });
  expect(await complete(item)).toMatchObject({ kind: 'account', created: true, newsletter: 'suppressed' });
});
