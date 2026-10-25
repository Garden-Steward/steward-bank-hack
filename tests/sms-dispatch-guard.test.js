'use strict';

const sms = require('../src/api/sms/services/sms');
let transport;
let usage;

beforeEach(() => {
  transport = { isDryRun: jest.fn(() => true), create: jest.fn(async () => ({ sid: 'synthetic-sid', numSegments: 1, simulated: true })) };
  usage = { canSend: jest.fn(async () => ({ allowed: true })), record: jest.fn(async () => {}) };
  global.strapi = {
    service(name) {
      if (name === 'api::sms.transport') return transport;
      if (name === 'api::billing.usage') return usage;
      if (name === 'api::billing.resolver') return { resolveContext: async () => ({ gardenDocumentId: null, organizationDocumentId: null }) };
      throw new Error('Unexpected service');
    },
    config: { get: jest.fn(() => 3) },
    log: { warn: jest.fn(), error: jest.fn() },
  };
});

const send = options => sms.send({ to: '+14155550100', body: 'Synthetic proof', category: 'system', source: 'identity.proof', throwOnError: true, ...options });

test.each(['false', 'undefined', 'undefined-value', 'invalid-function', 'exception'])('a %s authorization guard blocks the actual transport', async kind => {
  let dispatchGuard = async () => false;
  if (kind === 'undefined') dispatchGuard = async () => {};
  if (kind === 'undefined-value') dispatchGuard = undefined;
  if (kind === 'invalid-function') dispatchGuard = false;
  if (kind === 'exception') dispatchGuard = async () => { throw new Error('Synthetic authorization failure'); };
  const result = await send({ dispatchGuard });
  expect(transport.create).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: false, sid: null, blocked: true });
  expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ billable: false, blocked: true, twilio_sid: null }));
});

test('an explicit asynchronous allow sends the actual payload once', async () => {
  const result = await send({ dispatchGuard: async () => true });
  expect(transport.create).toHaveBeenCalledTimes(1);
  expect(transport.create).toHaveBeenCalledWith({ to: '+14155550100', body: 'Synthetic proof', mediaUrl: undefined });
  expect(result).toMatchObject({ ok: true, sid: 'synthetic-sid', blocked: false, simulated: true });
});

test('the existing bookkeeping hook remains best-effort when no authorization guard is supplied', async () => {
  const result = await send({ beforeSend: async () => { throw new Error('Synthetic bookkeeping failure'); } });
  expect(transport.create).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(true);
});

test('failed refused-send metering never authorizes transport', async () => {
  usage.record.mockRejectedValueOnce(new Error('Synthetic metering failure'));
  const result = await send({ dispatchGuard: async () => false });
  expect(transport.create).not.toHaveBeenCalled();
  expect(result.blocked).toBe(true);
});

test('authorization is checked after asynchronous bookkeeping changes eligibility', async () => {
  let revoked = false;
  const result = await send({ beforeSend: async () => { revoked = true; }, dispatchGuard: async () => !revoked });
  expect(transport.create).not.toHaveBeenCalled();
  expect(result.blocked).toBe(true);
});

test('mutating the shared options during bookkeeping cannot remove a supplied guard', async () => {
  const options = { to: '+14155550100', body: 'Synthetic proof', category: 'system', source: 'identity.proof', dispatchGuard: async () => false };
  options.beforeSend = async () => { delete options.dispatchGuard; };
  const result = await sms.send(options);
  expect(transport.create).not.toHaveBeenCalled();
  expect(result.blocked).toBe(true);
});
