'use strict';

jest.mock('../src/api/participation/participation-internal/constraints', () => ({ ensureConstraints: jest.fn() }));
const { ensureConstraints } = require('../src/api/participation/participation-internal/constraints');
const createService = require('../src/api/participation/services/participation');

function pendingCheck() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  ensureConstraints.mockReturnValueOnce(promise);
  return { resolve, reject };
}

beforeEach(() => ensureConstraints.mockReset());

test('overlapping storage checks share one result and stay unavailable until it passes', async () => {
  const service = createService({ strapi: {} });
  const check = pendingCheck();
  const first = service.ensureStorage();
  const second = service.ensureStorage();
  expect(ensureConstraints).toHaveBeenCalledTimes(1);
  expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
  check.resolve();
  await Promise.all([first, second]);
  expect(() => service.assertStorageReady()).not.toThrow();
});

test.each(['first', 'second'])('failed overlapping checks stay unavailable when the %s caller is observed first', async order => {
  const service = createService({ strapi: {} });
  const check = pendingCheck();
  const first = service.ensureStorage();
  const second = service.ensureStorage();
  let callers = [first, second];
  if (order === 'second') callers = [second, first];
  const results = Promise.allSettled(callers);
  check.reject(new Error('constraint drift'));
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(ensureConstraints).toHaveBeenCalledTimes(1);
  expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
});

test('a failed recheck clears previous readiness and a later retry can recover', async () => {
  const service = createService({ strapi: {} });
  ensureConstraints.mockResolvedValueOnce();
  await service.ensureStorage();
  service.assertStorageReady();
  const check = pendingCheck();
  const recheck = service.ensureStorage();
  expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
  const failure = expect(recheck).rejects.toThrow('constraint drift');
  check.reject(new Error('constraint drift'));
  await failure;
  expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
  ensureConstraints.mockResolvedValueOnce();
  await service.ensureStorage();
  service.assertStorageReady();
  expect(ensureConstraints).toHaveBeenCalledTimes(3);
});

test('cutover storage failure stays unavailable and a later setup retry can recover', async () => {
  const previous = process.env.PARTICIPATION_ENABLED;
  process.env.PARTICIPATION_ENABLED = 'true';
  const get = jest.fn().mockRejectedValueOnce(new Error('cutover storage unavailable')).mockResolvedValueOnce({ version: 1 });
  const service = createService({ strapi: { store: () => ({ get }) } });
  ensureConstraints.mockResolvedValue();
  try {
    await expect(service.ensureStorage()).rejects.toThrow('cutover storage unavailable');
    expect(() => service.assertStorageReady()).toThrow('Participation storage is unavailable');
    await service.ensureStorage();
    expect(() => service.assertStorageReady()).not.toThrow();
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    if (previous === undefined) delete process.env.PARTICIPATION_ENABLED;
    else process.env.PARTICIPATION_ENABLED = previous;
  }
});
