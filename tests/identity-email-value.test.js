'use strict';

const emailValue = require('../src/api/auth/join-identity-internal/contact-value');
const createProofCrypto = require('../src/api/auth/join-identity-internal/proof-crypto');

test('email raw text remains exact while delivery normalization is separate', () => {
  const rawValue = '  First.Last+Garden@Example.Co.Uk  ';
  expect(emailValue(rawValue)).toEqual({ rawValue, deliveryValue: 'First.Last+Garden@example.co.uk' });
});

test('email identity preserves local case, dots and plus aliases while folding only domain case', () => {
  const tools = createProofCrypto('a'.repeat(64));
  const destination = raw => tools.destinationKey('email', emailValue(raw).deliveryValue);
  expect(destination('Person@EXAMPLE.COM')).toBe(destination('Person@example.com'));
  expect(destination('Person@example.com')).not.toBe(destination('person@example.com'));
  expect(destination('First.Last@example.com')).not.toBe(destination('FirstLast@example.com'));
  expect(destination('Person+garden@example.com')).not.toBe(destination('Person@example.com'));
});

test('a320character raw value is preserved without truncating a valid delivery address', () => {
  const delivery = 'synthetic@example.com';
  const rawValue = ' '.repeat(320 - delivery.length) + delivery;
  expect(rawValue.length).toBe(320);
  expect(emailValue(rawValue)).toEqual({ rawValue, deliveryValue: delivery });
});

test.each([null, 123, '', 'example.com', 'Person.example.com', '@example.com', 'a@@example.com', 'a@example.com\n', 'a\r@example.com', 'a\0@example.com', 'a,b@example.com', 'a..b@example.com', '.a@example.com', 'a.@example.com', 'a@-example.com', 'a@example..com', 'a@localhost', 'a'.repeat(65) + '@example.com', ' '.repeat(321) + 'a@example.com'])('unsafe or unsupported email input is refused without coercion', rawValue => {
  expect(() => emailValue(rawValue)).toThrow('A valid email is required');
});
