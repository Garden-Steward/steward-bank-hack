'use strict';

const crypto = require('node:crypto');
const createProofCrypto = require('../src/api/auth/join-identity-internal/proof-crypto');
const key = () => crypto.randomBytes(32).toString('hex');
const proof = () => ({ purpose: 'join_identity', receiptId: crypto.randomUUID(), generation: 1, destinationKey: key(), browserSecretHash: key() });

test('keys require full256bit material and browser secrets are not coerced', () => {
  for (const value of ['', 'password', 'a'.repeat(63), null, 123]) expect(() => createProofCrypto(value)).toThrow('Invalid proof material');
  const tools = createProofCrypto(key());
  expect(() => tools.browserHash(' ' + key())).toThrow('Invalid proof material');
  expect(() => tools.browserHash(123)).toThrow('Invalid proof material');
});

test('contact identity is stable across proof purposes while channel and key stay separate', () => {
  const master = key();
  const tools = createProofCrypto(master);
  const value = 'synthetic@example.com';
  expect(tools.destinationKey('email', value)).toBe(createProofCrypto(master).destinationKey('email', value));
  expect(tools.destinationKey('email', value)).not.toBe(tools.destinationKey('sms', value));
  expect(tools.destinationKey('email', value)).not.toBe(createProofCrypto(key()).destinationKey('email', value));
  expect(tools.destinationKey('email', value)).not.toBe(tools.destinationKey('email', ' ' + value));
  const secret = key();
  expect(tools.browserHash(secret)).not.toBe(tools.destinationKey('email', secret));
});

test('leadingzero codes remain exact and invalid code input never matches', () => {
  const tools = createProofCrypto(key());
  const item = proof();
  item.codeHmac = tools.codeHash(item, '00001234');
  expect(tools.matchesCode(item, '00001234')).toBe(true);
  for (const value of ['1234', 1234, ' 00001234', '00001235', null, 'abcdefgh']) expect(tools.matchesCode(item, value)).toBe(false);
  for (let i = 0; i < 20; i++) expect(tools.generateCode()).toMatch(/^\d{8}$/);
});

test.each(['purpose', 'receiptId', 'generation', 'destinationKey', 'browserSecretHash'])('a code cannot cross its %s binding', field => {
  const tools = createProofCrypto(key());
  const item = proof();
  item.codeHmac = tools.codeHash(item, '00001234');
  const changed = { ...item };
  if (field === 'purpose') changed.purpose = 'email_login';
  else if (field === 'receiptId') changed.receiptId = crypto.randomUUID();
  else if (field === 'generation') changed.generation = 2;
  else changed[field] = key();
  expect(tools.matchesCode(changed, '00001234')).toBe(false);
});

test('payloads round trip exact delivery values and use fresh ciphertext each time', () => {
  const tools = createProofCrypto(key());
  const item = proof();
  const delivery = ' Synthetic+Garden@Example.com ';
  const first = tools.seal(item, delivery, '00001234');
  const second = tools.seal(item, delivery, '00001234');
  expect(first).not.toBe(second);
  expect(first).not.toContain(delivery);
  expect(first).not.toContain('00001234');
  expect(tools.open(item, first)).toEqual({ deliveryValue: delivery, code: '00001234' });
});

test.each(['purpose', 'receiptId', 'generation', 'destinationKey', 'browserSecretHash'])('a sealed payload cannot cross its %s binding', field => {
  const tools = createProofCrypto(key());
  const item = proof();
  const payload = tools.seal(item, 'synthetic@example.com', '00001234');
  const changed = { ...item };
  if (field === 'purpose') changed.purpose = 'profile_email';
  else if (field === 'receiptId') changed.receiptId = crypto.randomUUID();
  else if (field === 'generation') changed.generation = 2;
  else changed[field] = key();
  expect(() => tools.open(changed, payload)).toThrow('Invalid proof material');
});

test('tampered ciphertext, IV, tag, format and key all fail with one generic error', () => {
  const tools = createProofCrypto(key());
  const item = proof();
  const payload = tools.seal(item, 'synthetic@example.com', '00001234');
  for (const index of [1, 2, 3]) {
    const parts = payload.split('.');
    const bytes = Buffer.from(parts[index], 'base64url');
    bytes[0] ^= 1;
    parts[index] = bytes.toString('base64url');
    expect(() => tools.open(item, parts.join('.'))).toThrow('Invalid proof material');
  }
  for (const value of ['', 'v2.' + payload.slice(3), payload + '.extra', 'a'.repeat(4097), null]) expect(() => tools.open(item, value)).toThrow('Invalid proof material');
  expect(() => createProofCrypto(key()).open(item, payload)).toThrow('Invalid proof material');
});
