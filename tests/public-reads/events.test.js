'use strict';

process.env.DATABASE_FILENAME = '.tmp/public-reads-events.db';
process.env.UPLOAD_PROVIDER = 'local';
process.env.EMAIL_DRY_RUN = 'true';
process.env.SMS_DRY_RUN = 'true';
process.env.CRON_ENABLED = 'false';
process.env.ENVIRONMENT = 'test';
process.env.JWT_SECRET = 'public-reads-test-jwt';
process.env.API_TOKEN_SALT = 'public-reads-test-api';
process.env.ADMIN_JWT_SECRET = 'public-reads-test-admin';
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'public-reads-test-token';

const request = require('supertest');
const { setupStrapi, cleanupStrapi } = require('../helpers/strapi');
const SENTINEL = 'PRIVATE_SENTINEL_PUBLIC_READS';
const eventUid = 'api::volunteer-day.volunteer-day';
let visible;
let gardenless;
let publishedGarden;
let draftGarden;
let media;

beforeAll(async () => {
  await setupStrapi();
  const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
  const permissions = await strapi.db.query('plugin::users-permissions.permission').findMany({ where: { role: publicRole.id } });
  for (const permission of permissions) await strapi.db.query('plugin::users-permissions.permission').delete({ where: { id: permission.id } });
  media = await strapi.db.query('plugin::upload.file').create({ data: {
    name: 'public-test.jpg', hash: 'public-test', mime: 'image/jpeg', size: 1,
    url: '/uploads/public-test.jpg', width: 200, height: 100, provider: 'local',
    alternativeText: '', provider_metadata: { private: SENTINEL },
    formats: { small: { url: '/uploads/public-test-small.jpg', width: 100, height: 50, private: SENTINEL }, private: { value: SENTINEL } },
  } });
  const org = await strapi.documents('api::organization.organization').create({ status: 'published', data: { title: 'Public host', venmo_handle: SENTINEL } });
  publishedGarden = await strapi.documents('api::garden.garden').create({ status: 'published', data: { title: 'Public garden', slug: 'public-garden', sms_slug: 'public-read-garden', welcome_text: SENTINEL, latitude: 37.812345, longitude: -122.234567, organization: org.documentId, hero_image: media.id } });
  draftGarden = await strapi.documents('api::garden.garden').create({ data: { title: 'Draft garden', slug: 'draft-garden', sms_slug: 'draft-read-garden' } });
  const future = new Date(Date.now() + 86400000).toISOString();
  visible = await strapi.documents(eventUid).create({ status: 'published', data: { title: 'Visible public event', startDatetime: future, garden: publishedGarden.documentId, accessibility: 'Public', location_address: SENTINEL } });
  gardenless = await strapi.documents(eventUid).create({ status: 'published', data: { title: 'Public gardenless event', startDatetime: new Date(Date.now() + 90000000).toISOString(), accessibility: 'Public' } });
  let sequence = 0;
  for (const data of [
    { title: 'Hidden private event', accessibility: 'Garden Members' },
    { title: 'Hidden invite event', accessibility: 'Invite Only' },
    { title: 'Hidden disabled event', disabled: true },
    { title: 'Hidden canceled event', canceled: true },
    { title: 'Hidden draft-garden event', garden: draftGarden.documentId },
    { title: 'Hidden old event', startDatetime: new Date(Date.now() - 91 * 86400000).toISOString() },
  ]) {
    const created = await strapi.documents(eventUid).create({ status: 'published', data: { startDatetime: new Date(Date.now() + 95000000 + sequence++ * 3600000).toISOString(), accessibility: 'Public', ...data } });
    if (data.garden === draftGarden.documentId) {
      // comment-ok: Publishing drops unpublished relations; retain a legacy draft link to test the boundary.
      await strapi.db.query(eventUid).update({ where: { id: created.id }, data: { garden: draftGarden.id } });
      const stored = await strapi.db.query(eventUid).findOne({ where: { id: created.id }, populate: ['garden'] });
      expect(stored.garden.publishedAt).toBeNull();
    }
  }
  await strapi.documents(eventUid).create({ data: { title: 'Hidden draft event', startDatetime: new Date(Date.now() + 200000000).toISOString(), accessibility: 'Public' } });
}, 120000);

afterAll(async () => { await cleanupStrapi(); });

function http() { return request(strapi.server.httpServer); }

it('serves only eligible published events anonymously without public core grants', async () => {
  const res = await http().get('/api/volunteer-days/public').expect(200);
  expect(res.body.data.map(event => event.title).sort()).toEqual(['Public gardenless event', 'Visible public event']);
  expect(res.body.data.map(event => event.documentId).sort()).toEqual([visible.documentId, gardenless.documentId].sort());
  expect(res.body.meta.pagination).toEqual({ page: 1, pageSize: 15, pageCount: 1, total: 2 });
  expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  const item = res.body.data.find(event => event.documentId === visible.documentId);
  expect(Object.keys(item).sort()).toEqual(['id', 'documentId', 'title', 'blurb', 'startDatetime', 'canceled', 'location_name', 'hero_image', 'garden'].sort());
  expect(Object.keys(item.garden).sort()).toEqual(['documentId', 'slug', 'title', 'hero_image', 'organization'].sort());
  expect(item.garden.organization).toEqual({ title: 'Public host' });
  expect(item.hero_image.alternativeText).toBe('');
  expect(item.hero_image.formats).toEqual({ small: { url: '/uploads/public-test-small.jpg', width: 100, height: 50 } });
  const protectedRead = await http().get('/api/gardens');
  const protectedWrite = await http().post('/api/gardens').send({ data: { title: 'Not created' } });
  expect([401, 403]).toContain(protectedRead.status);
  expect([401, 403]).toContain(protectedWrite.status);
});

it('supports bounded accurate pages and ignores only legacy population hints', async () => {
  const first = await http().get('/api/volunteer-days/public?pagination[pageSize]=1&populate[garden][populate]=*').expect(200);
  expect(first.body.data).toHaveLength(1);
  expect(first.body.meta.pagination).toEqual({ page: 1, pageSize: 1, pageCount: 2, total: 2 });
  const second = await http().get('/api/volunteer-days/public?pagination[page]=2&pagination[pageSize]=1').expect(200);
  expect(second.body.data[0].documentId).not.toBe(first.body.data[0].documentId);
  const beyond = await http().get('/api/volunteer-days/public?pagination[page]=3&pagination[pageSize]=1').expect(200);
  expect(beyond.body.data).toEqual([]);
  expect(beyond.body.meta.pagination.total).toBe(2);
});

it.each([
  'pagination[page]=0', 'pagination[page]=-1', 'pagination[page]=1.5', 'pagination[page]=1x',
  'pagination[page]=1&pagination[page]=2', 'pagination[page][]=1', 'pagination[pageSize]=101',
  'pagination[page]=100002&pagination[pageSize]=1', 'pagination[start]=0', 'sort=title', 'filters[title]=x',
])('rejects unsafe or ambiguous query %s', async query => {
  await http().get('/api/volunteer-days/public?' + query).expect(400);
});
