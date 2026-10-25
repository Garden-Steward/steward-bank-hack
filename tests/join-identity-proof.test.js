'use strict';

const crypto = require('node:crypto');
const { setupStrapi, cleanupStrapi } = require('./helpers/strapi');
const createProofCrypto = require('../src/api/auth/join-identity-internal/proof-crypto');

const key = () => crypto.randomBytes(32).toString('hex');
const requestId = () => crypto.randomUUID();
const MASTER = key();
const tools = createProofCrypto(MASTER);
let owner;
let emailService;
let originalSend;
let previousKey;
let inbox;
let sendTransactions;
let provider;
const proofQuery = () => strapi.db.query('api::participation.contact-proof');
const requestQuery = () => strapi.db.query('api::participation.participation-request');
const proofTable = () => strapi.db.metadata.get('api::participation.contact-proof').tableName;
const intentQuery = () => strapi.db.query('api::participation.join-intent');
const fixture = async () => {
  const user = await strapi.db.query('plugin::users-permissions.user').create({ data: { username: requestId(), provider: 'local', confirmed: true, blocked: false } });
  return { purpose: 'profile_email', actorId: user.id, rawValue: '  SYNTHETIC.' + requestId().toUpperCase() + '@EXAMPLE.COM  ', browserSecret: key(), socketPeer: '127.0.0.1', requestId: requestId() };
};
const issue = command => owner.withTransaction(trx => owner.requestEmailProof(trx, command));
const resend = command => owner.withTransaction(trx => owner.resendEmailProof(trx, command));
const consume = submission => owner.withTransaction(trx => owner.consumeEmailProof(trx, submission));
const savedProof = result => proofQuery().findOne({ where: { receiptId: result.public.proofId } });
const code = entry => entry.text.match(/code is (\d{8})/)[1];
const submission = (command, result, value) => ({ proofId: result.public.proofId, browserSecret: command.browserSecret, actorId: command.actorId, purpose: command.purpose, code: value });
async function allowResend(result) {
  await strapi.db.connection(proofTable()).where({ receipt_id: result.public.proofId }).update({ expires_at: new Date(Date.now() + 10 * 60000 - 61000) });
}
function pending() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

beforeAll(async () => {
  previousKey = process.env.PARTICIPATION_IDENTITY_KEY;
  process.env.PARTICIPATION_IDENTITY_KEY = MASTER;
  await setupStrapi();
  owner = strapi.service('api::auth.join-identity');
  emailService = strapi.plugin('email').service('email');
  originalSend = emailService.send;
  emailService.send = async options => { inbox.push(options); sendTransactions.push(strapi.db.inTransaction()); return provider(options); };
});
beforeEach(() => { inbox = []; sendTransactions = []; provider = async () => ({ simulated: true }); });
afterAll(async () => {
  emailService.send = originalSend;
  await cleanupStrapi();
  if (previousKey === undefined) delete process.env.PARTICIPATION_IDENTITY_KEY;
  else process.env.PARTICIPATION_IDENTITY_KEY = previousKey;
});

test('proof mutations require the actual identity transaction and reject foreign nesting', async () => {
  const command = await fixture();
  await expect(owner.requestEmailProof({}, command)).rejects.toMatchObject({ code: 'IDENTITY_TRANSACTION_REQUIRED' });
  await strapi.db.transaction(async () => { await expect(owner.withTransaction(async () => {})).rejects.toMatchObject({ code: 'IDENTITY_FOREIGN_TRANSACTION' }); });
  expect(inbox).toEqual([]);
});

test('issue commits exact raw values and sealed payload without sending until a separate claim', async () => {
  const command = await fixture();
  const result = await issue(command);
  expect(inbox).toEqual([]);
  const proof = await savedProof(result);
  expect(proof.rawValue).toBe(command.rawValue);
  expect(proof.deliveryValue).toBe(command.rawValue.trim().toLowerCase());
  expect(proof.sealedPayload).toMatch(/^v1\./);
  expect(JSON.stringify(result.public)).not.toContain(command.rawValue);
  expect(JSON.stringify(result.public)).not.toContain(command.browserSecret);
  expect(await owner.deliverEmailProof(result.delivery.requestReceiptId)).toEqual({ kind: 'delivery_result', state: 'simulated', recorded: true });
  expect(inbox).toHaveLength(1);
  expect(inbox[0].to).toBe(proof.deliveryValue);
  expect(sendTransactions).toEqual([false]);
  expect((await savedProof(result)).sealedPayload).toBeNull();
  expect((await savedProof(result)).sendState).toBe('simulated');
  expect((await consume(submission(command, result, code(inbox[0])))).kind).toBe('verified');
  expect((await consume(submission(command, result, code(inbox[0])))).kind).toBe('invalid_proof');
});

test('admitted UUID replay is stable across object key order and rejects changed input', async () => {
  const command = await fixture();
  command.requestInput = { event: 'synthetic', draft: { name: '  Person  ', preferences: ['a', 'b'] } };
  const first = await issue(command);
  const replay = await issue({ ...command, requestInput: { draft: { preferences: ['a', 'b'], name: '  Person  ' }, event: 'synthetic' }, socketPeer: '::1' });
  expect(replay).toEqual(first);
  await expect(issue({ ...command, rawValue: 'different@example.com' })).rejects.toMatchObject({ code: 'IDENTITY_REQUEST_CONFLICT' });
  expect(await proofQuery().count({ where: { actorId: command.actorId } })).toBe(1);
  expect(await requestQuery().count({ where: { actorOrBrowserScope: 'identity:actor:' + command.actorId } })).toBe(1);
});

test('cooldown rejection creates no receipt and a later resend supersedes the old generation', async () => {
  const command = await fixture();
  const first = await issue(command);
  const original = await savedProof(first);
  const oldCode = tools.open(original, original.sealedPayload).code;
  const next = { ...command, proofId: first.public.proofId, requestId: requestId() };
  expect(await resend(next)).toMatchObject({ kind: 'rejected', code: 'IDENTITY_COOLDOWN' });
  expect(await requestQuery().count({ where: { actorOrBrowserScope: 'identity:actor:' + command.actorId } })).toBe(1);
  await allowResend(first);
  const second = await resend(next);
  expect(second.delivery.generation).toBe(2);
  expect(await owner.deliverEmailProof(first.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
  expect(inbox).toEqual([]);
  await owner.deliverEmailProof(second.delivery.requestReceiptId);
  expect((await consume(submission(command, second, oldCode))).kind).toBe('invalid_proof');
  expect((await consume(submission(command, second, code(inbox[0])))).kind).toBe('verified');
});

test('a consumed ownership proof cannot be rewritten by a fresh resend command', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  await consume(submission(command, result, code(inbox[0])));
  await allowResend(result);
  const before = await savedProof(result);
  expect(await resend({ ...command, proofId: result.public.proofId, requestId: requestId() })).toMatchObject({ kind: 'rejected', code: 'IDENTITY_PROOF_UNAVAILABLE' });
  const after = await savedProof(result);
  expect(after.generation).toBe(before.generation);
  expect(after.consumedAt).toBe(before.consumedAt);
  expect(after.rawValue).toBe(before.rawValue);
});

test('concurrent wrong codes commit at most five attempts and then reject the correct code too', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const correct = code(inbox[0]);
  const wrong = correct.slice(0, 7) + String((Number(correct[7]) + 1) % 10);
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => consume(submission(command, result, wrong))));
  expect(outcomes.map(outcome => outcome.kind)).toEqual(Array(8).fill('invalid_proof'));
  expect((await savedProof(result)).attempts).toBe(5);
  expect((await consume(submission(command, result, correct))).kind).toBe('invalid_proof');
});

test('only one concurrent valid proof consumption succeeds', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const outcomes = await Promise.all([consume(submission(command, result, code(inbox[0]))), consume(submission(command, result, code(inbox[0])))]);
  expect(outcomes.map(outcome => outcome.kind).sort()).toEqual(['invalid_proof', 'verified']);
});

test('wrong browser, purpose and actor cannot use a profile proof', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const input = submission(command, result, code(inbox[0]));
  for (const changed of [{ browserSecret: key() }, { purpose: 'email_login' }, { actorId: command.actorId + 10000 }]) expect((await consume({ ...input, ...changed })).kind).toBe('invalid_proof');
  expect((await savedProof(result)).attempts).toBe(0);
  expect((await consume(input)).kind).toBe('verified');
});

test('issuance cap rollback removes a provisional intent and records no rejected request or proof', async () => {
  const command = await fixture();
  const admitted = [];
  for (let index = 0; index < 5; index++) {
    const input = { ...command, requestId: requestId() };
    admitted.push({ input, result: await issue(input) });
  }
  expect(await issue(admitted[0].input)).toEqual(admitted[0].result);
  const before = { intents: await intentQuery().count(), proofs: await proofQuery().count(), requests: await requestQuery().count() };
  const rejectedId = requestId();
  const outcome = await owner.withTransaction(async trx => {
    await intentQuery().create({ data: { receiptId: key(), eventDocumentId: key(), browserSecretHash: tools.browserHash(command.browserSecret), requestId: rejectedId, requestHmac: key(), draftJson: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    return owner.requestEmailProof(trx, { ...command, requestId: rejectedId });
  });
  expect(outcome).toMatchObject({ kind: 'rejected', code: 'IDENTITY_RATE_LIMITED' });
  expect({ intents: await intentQuery().count(), proofs: await proofQuery().count(), requests: await requestQuery().count() }).toEqual(before);
  expect(inbox).toEqual([]);
});

test('outer finalization failure rolls back consumption, contact ownership and newsletter enrollment together', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const input = submission(command, result, code(inbox[0]));
  await expect(owner.withTransaction(async trx => {
    const verified = await owner.consumeEmailProof(trx, input);
    expect(verified.kind).toBe('verified');
    const mapping = await strapi.db.query('api::participation.verified-contact').create({ data: { channel: 'email', destinationKey: verified.proof.destinationKey, userId: command.actorId, proofId: verified.proof.id, verifiedAt: new Date().toISOString() } });
    const newsletter = strapi.service('api::newsletter.newsletter');
    await newsletter.ensureAccountSubscription({ userId: command.actorId, verifiedContactId: mapping.id, disclosureVersion: newsletter.disclosure.version });
    throw new Error('Synthetic finalization rollback');
  })).rejects.toThrow('Synthetic finalization rollback');
  expect((await savedProof(result)).consumedAt).toBeNull();
  expect(await strapi.db.query('api::participation.verified-contact').count({ where: { userId: command.actorId } })).toBe(0);
  expect(await strapi.db.query('api::newsletter.newsletter-subscription').count({ where: { userId: command.actorId } })).toBe(0);
  expect((await consume(input)).kind).toBe('verified');
});

test('a late provider acceptance cannot overwrite a newer resend generation', async () => {
  const command = await fixture();
  const first = await issue(command);
  const entered = pending();
  const release = pending();
  provider = async () => { entered.resolve(); return release.promise; };
  const sending = owner.deliverEmailProof(first.delivery.requestReceiptId);
  await entered.promise;
  let second;
  try {
    const claimed = await savedProof(first);
    expect(claimed.sendState).toBe('queued');
    expect(claimed.sealedPayload).toBeNull();
    expect(sendTransactions).toEqual([false]);
    expect(await owner.deliverEmailProof(first.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
    await allowResend(first);
    second = await resend({ ...command, proofId: first.public.proofId, requestId: requestId() });
  } finally { release.resolve({ id: 'synthetic-old-provider-id' }); }
  expect(await sending).toEqual({ kind: 'delivery_result', state: 'accepted', recorded: false });
  const current = await savedProof(second);
  expect(current.generation).toBe(2);
  expect(current.sendState).toBe('pending');
  expect(current.providerId).toBeNull();
  provider = async () => ({ simulated: true });
  await owner.deliverEmailProof(second.delivery.requestReceiptId);
  expect(inbox).toHaveLength(2);
});

test('ambiguous provider failure is unknown and the claimed generation is never automatically retried', async () => {
  const command = await fixture();
  const result = await issue(command);
  provider = async () => { throw new Error('Synthetic lost acknowledgement'); };
  expect(await owner.deliverEmailProof(result.delivery.requestReceiptId)).toEqual({ kind: 'delivery_result', state: 'unknown', recorded: true });
  expect(await owner.deliverEmailProof(result.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
  expect(inbox).toHaveLength(1);
  expect((await savedProof(result)).sealedPayload).toBeNull();
});

test('expired pending payload cleanup is bounded and never dispatches mail', async () => {
  const command = await fixture();
  const first = await issue(command);
  const second = await issue({ ...command, requestId: requestId() });
  await strapi.db.connection(proofTable()).whereIn('receipt_id', [first.public.proofId, second.public.proofId]).update({ expires_at: new Date(Date.now() - 1000) });
  expect(await owner.clearExpiredProofPayloads({ limit: 1 })).toEqual({ cleared: 1 });
  expect(await owner.clearExpiredProofPayloads({ limit: 1 })).toEqual({ cleared: 1 });
  expect(await owner.deliverEmailProof(first.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
  expect(inbox).toEqual([]);
});

async function ownedEmail(command) {
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const verified = await consume(submission(command, result, code(inbox[inbox.length - 1])));
  expect(verified.kind).toBe('verified');
  const mapping = await strapi.db.query('api::participation.verified-contact').create({ data: { channel: 'email', destinationKey: verified.proof.destinationKey, userId: command.actorId, proofId: verified.proof.id, verifiedAt: new Date().toISOString() } });
  return mapping;
}

test('known and unknown email login requests share a safe shape and neither creates an account', async () => {
  const profile = await fixture();
  await ownedEmail(profile);
  inbox = [];
  const before = await strapi.db.query('plugin::users-permissions.user').count();
  const knownCommand = { ...profile, purpose: 'email_login', actorId: undefined, browserSecret: key(), requestId: requestId() };
  const unknownCommand = { ...knownCommand, rawValue: 'unknown.' + requestId() + '@example.com', browserSecret: key(), requestId: requestId() };
  const known = await issue(knownCommand);
  const unknown = await issue(unknownCommand);
  expect(Object.keys(known.public).sort()).toEqual(Object.keys(unknown.public).sort());
  expect(known.public.kind).toBe(unknown.public.kind);
  expect(known.public.verification).toEqual(unknown.public.verification);
  expect(known.public.proofId).toMatch(/^[a-f0-9]{64}$/);
  expect(unknown.public.proofId).toMatch(/^[a-f0-9]{64}$/);
  expect((await savedProof(unknown)).actorId).toBeNull();
  expect((await savedProof(unknown)).sealedPayload).toBeNull();
  expect(await owner.deliverEmailProof(unknown.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
  expect(inbox).toEqual([]);
  await owner.deliverEmailProof(known.delivery.requestReceiptId);
  const verified = await consume(submission(knownCommand, known, code(inbox[0])));
  expect(verified.kind).toBe('verified');
  expect(verified.proof.actorId).toBe(profile.actorId);
  expect(await strapi.db.query('plugin::users-permissions.user').count()).toBe(before);
});

test('a revoked registry mapping cannot authorize email login after its code was delivered', async () => {
  const profile = await fixture();
  const mapping = await ownedEmail(profile);
  const command = { ...profile, purpose: 'email_login', actorId: undefined, browserSecret: key(), requestId: requestId() };
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const delivered = code(inbox[inbox.length - 1]);
  await strapi.db.query('api::participation.verified-contact').update({ where: { id: mapping.id }, data: { revokedAt: new Date().toISOString() } });
  expect((await consume(submission(command, result, delivered))).kind).toBe('invalid_proof');
  expect((await savedProof(result)).consumedAt).toBeNull();
});

test('a blocked actor cannot complete a previously delivered profile proof', async () => {
  const command = await fixture();
  const result = await issue(command);
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  await strapi.db.query('plugin::users-permissions.user').update({ where: { id: command.actorId }, data: { blocked: true } });
  expect((await consume(submission(command, result, code(inbox[0])))).kind).toBe('invalid_proof');
});

test('join proof issuance and verification remain bound to the actual pending intent and browser', async () => {
  const command = await fixture();
  command.purpose = 'join_identity';
  command.actorId = undefined;
  const intent = await intentQuery().create({ data: { receiptId: key(), eventDocumentId: key(), browserSecretHash: tools.browserHash(command.browserSecret), requestId: command.requestId, requestHmac: key(), draftJson: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } });
  command.intentId = intent.id;
  const result = await issue(command);
  expect(result.scopeReceiptId).toBe(intent.receiptId);
  await expect(issue({ ...command, intentId: intent.id + 10000 })).rejects.toMatchObject({ code: 'IDENTITY_REQUEST_CONFLICT' });
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  const input = { ...submission(command, result, code(inbox[0])), intentId: intent.id };
  expect((await consume({ ...input, intentId: intent.id + 10000 })).kind).toBe('invalid_proof');
  expect((await consume(input)).kind).toBe('verified');
});

test('an expired intent cannot create an admitted proof or send mail', async () => {
  const command = await fixture();
  command.purpose = 'join_identity';
  command.actorId = undefined;
  const intent = await intentQuery().create({ data: { receiptId: key(), eventDocumentId: key(), browserSecretHash: tools.browserHash(command.browserSecret), requestId: command.requestId, requestHmac: key(), draftJson: {}, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const before = await requestQuery().count();
  expect(await issue({ ...command, intentId: intent.id })).toMatchObject({ kind: 'rejected', code: 'IDENTITY_SCOPE_UNAVAILABLE' });
  expect(await proofQuery().count({ where: { intentId: intent.id } })).toBe(0);
  expect(await requestQuery().count()).toBe(before);
  expect(inbox).toEqual([]);
});

test('actual native user.add can omit unverified legacy contact fields without welcome delivery', async () => {
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  let id;
  await expect(owner.withTransaction(async () => {
    const user = await strapi.plugin('users-permissions').service('user').add({ username: 'identity_' + requestId(), provider: 'local', confirmed: true, blocked: false, role: role.id });
    id = user.id;
    const saved = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id } });
    expect(saved.email == null).toBe(true);
    expect(saved.phoneNumber == null).toBe(true);
    throw new Error('Synthetic minimal-account rollback');
  })).rejects.toThrow('Synthetic minimal-account rollback');
  expect(await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id } })).toBeNull();
  expect(inbox).toEqual([]);
});

test('a different configured identity key cannot silently take over an existing registry namespace', async () => {
  const command = await fixture();
  await issue(command);
  const createOwner = require('../src/api/auth/services/join-identity');
  const before = { proofs: await proofQuery().count(), requests: await requestQuery().count() };
  let called = false;
  process.env.PARTICIPATION_IDENTITY_KEY = key();
  try {
    const wrongOwner = createOwner({ strapi });
    await expect(wrongOwner.withTransaction(async () => { called = true; })).rejects.toMatchObject({ code: 'IDENTITY_KEY_MISMATCH' });
  } finally { process.env.PARTICIPATION_IDENTITY_KEY = MASTER; }
  expect(called).toBe(false);
  expect({ proofs: await proofQuery().count(), requests: await requestQuery().count() }).toEqual(before);
  const sameOwner = createOwner({ strapi });
  expect(await sameOwner.withTransaction(async () => 'same-key')).toBe('same-key');
});

test('missing key state with existing proof records refuses initialization instead of adopting a key', async () => {
  const store = strapi.db.query('strapi::core-store');
  const where = { key: 'plugin_garden-identity_key-v1-fingerprint', environment: null, tag: null };
  const saved = await store.findOne({ where });
  await store.delete({ where: { id: saved.id } });
  try {
    await expect(owner.withTransaction(async () => {})).rejects.toMatchObject({ code: 'IDENTITY_KEY_STATE_MISSING' });
    expect(await store.findOne({ where })).toBeNull();
  } finally {
    await store.create({ data: { key: saved.key, value: saved.value, type: saved.type, environment: saved.environment, tag: saved.tag } });
  }
});

test('resend request receipts bind purpose and intent scope even on an admitted replay', async () => {
  const command = await fixture();
  const first = await issue(command);
  await allowResend(first);
  const next = { ...command, proofId: first.public.proofId, requestId: requestId() };
  await resend(next);
  await expect(resend({ ...next, purpose: 'email_login' })).rejects.toMatchObject({ code: 'IDENTITY_REQUEST_CONFLICT' });
  await expect(resend({ ...next, intentId: 99999 })).rejects.toMatchObject({ code: 'IDENTITY_REQUEST_CONFLICT' });
});

test('a leadingzero code survives the real sealed delivery and verification path', async () => {
  const command = await fixture();
  const result = await issue(command);
  const proof = await savedProof(result);
  await proofQuery().update({ where: { id: proof.id }, data: { codeHmac: tools.codeHash(proof, '00001234'), sealedPayload: tools.seal(proof, proof.deliveryValue, '00001234') } });
  await owner.deliverEmailProof(result.delivery.requestReceiptId);
  expect(code(inbox[0])).toBe('00001234');
  expect((await consume(submission(command, result, '1234'))).kind).toBe('invalid_proof');
  expect((await consume(submission(command, result, '00001234'))).kind).toBe('verified');
});

test('attempting delivery before the outer commit rolls back issuance and never calls a provider', async () => {
  const command = await fixture();
  const before = { proofs: await proofQuery().count(), requests: await requestQuery().count() };
  await expect(owner.withTransaction(async trx => {
    const result = await owner.requestEmailProof(trx, command);
    await owner.deliverEmailProof(result.delivery.requestReceiptId);
  })).rejects.toMatchObject({ code: 'IDENTITY_FOREIGN_TRANSACTION' });
  expect({ proofs: await proofQuery().count(), requests: await requestQuery().count() }).toEqual(before);
  expect(inbox).toEqual([]);
});

test.each([false, true])('an intent that expires after issuance blocks later proof use, delivered=%s', async delivered => {
  const command = await fixture();
  command.purpose = 'join_identity';
  command.actorId = undefined;
  const intent = await intentQuery().create({ data: { receiptId: key(), eventDocumentId: key(), browserSecretHash: tools.browserHash(command.browserSecret), requestId: command.requestId, requestHmac: key(), draftJson: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } });
  command.intentId = intent.id;
  const result = await issue(command);
  let value = '00000000';
  if (delivered) { await owner.deliverEmailProof(result.delivery.requestReceiptId); value = code(inbox[0]); }
  await intentQuery().update({ where: { id: intent.id }, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  if (!delivered) {
    expect(await owner.deliverEmailProof(result.delivery.requestReceiptId)).toEqual({ kind: 'not_claimable' });
    expect(inbox).toEqual([]);
  }
  expect((await consume({ ...submission(command, result, value), intentId: intent.id })).kind).toBe('invalid_proof');
});
