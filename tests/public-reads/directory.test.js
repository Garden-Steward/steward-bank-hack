'use strict';

process.env.DATABASE_FILENAME = '.tmp/public-reads-directory.db';
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
const { patchService, restoreAll } = require('../helpers/patch');
const GARDEN = 'api::garden.garden';
const PROJECT = 'api::project.project';
const EVENT = 'api::volunteer-day.volunteer-day';
const SENTINEL = 'DIRECTORY_PRIVATE_SENTINEL';
let garden;
let draftGarden;
let user;
let approved;
let gardenless;
let completed;
let nextWorkday;
let media;
let secondMedia;
let token;
const now = Date.now();

beforeAll(async () => {
  await setupStrapi();
  const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
  const permissions = await strapi.db.query('plugin::users-permissions.permission').findMany({ where: { role: publicRole.id } });
  for (const permission of permissions) await strapi.db.query('plugin::users-permissions.permission').delete({ where: { id: permission.id } });
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  user = await strapi.db.query('plugin::users-permissions.user').create({ data: { username: 'private-volunteer', email: 'private-volunteer@example.test', phoneNumber: '+14155550123', firstName: SENTINEL, lastName: SENTINEL, role: role.id, confirmed: true, provider: 'local' } });
  token = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });
  media = await strapi.db.query('plugin::upload.file').create({ data: { name: 'gallery.jpg', hash: 'gallery', mime: 'image/jpeg', size: 1, url: '/uploads/gallery.jpg', provider: 'local', provider_metadata: { private: SENTINEL } } });
  secondMedia = await strapi.db.query('plugin::upload.file').create({ data: { name: 'gallery-second.jpg', hash: 'gallery-second', mime: 'image/jpeg', size: 1, url: '/uploads/gallery-second.jpg', provider: 'local' } });
  garden = await strapi.documents(GARDEN).create({ status: 'published', data: { title: 'Published garden', slug: 'published-garden', sms_slug: 'published-directory', welcome_text: SENTINEL, welcome_email_body: SENTINEL, boundary: { type: 'Polygon', coordinates: [[[-122.24, 37.81], [-122.23, 37.81], [-122.23, 37.82], [-122.24, 37.81]]] }, latitude: 37.812345, longitude: -122.234567, volunteers: [user.id], hero_image: media.id } });
  draftGarden = await strapi.documents(GARDEN).create({ data: { title: 'Hidden draft garden', slug: 'draft-garden', sms_slug: 'draft-directory' } });
  const noSlug = await strapi.documents(GARDEN).create({ status: 'published', data: { title: 'Hidden malformed slug', slug: 'valid-for-create', sms_slug: 'no-slug-directory' } });
  await strapi.db.query(GARDEN).updateMany({ where: { documentId: noSlug.documentId }, data: { slug: 'bad/slug' } });
  const base = { short_description: 'Public project description', review_status: 'APPROVED', submitter_email: 'private-submitter@example.test', verification_token: SENTINEL, review_note: SENTINEL, longitude: -122.234567, latitude: 37.812345 };
  approved = await strapi.documents(PROJECT).create({ data: { ...base, title: 'Approved project', slug: 'approved-project', garden: garden.documentId, hero_image: media.id, featured_gallery: [secondMedia.id, media.id], interested: [user.id] } });
  gardenless = await strapi.documents(PROJECT).create({ data: { ...base, title: 'Gardenless project', slug: 'gardenless-project' } });
  completed = await strapi.documents(PROJECT).create({ data: { ...base, title: 'Completed project', slug: 'completed-project', garden: garden.documentId, review_status: 'COMPLETED' } });
  for (const status of ['CREATED', 'CHANGES_REQUESTED', 'REJECTED', 'ARCHIVED']) await strapi.documents(PROJECT).create({ data: { ...base, title: 'Hidden ' + status, slug: status.toLowerCase(), review_status: status } });
  await strapi.documents(PROJECT).create({ data: { ...base, title: 'Hidden draft-garden project', slug: 'hidden-draft-project', garden: draftGarden.documentId } });
  await strapi.documents(PROJECT).create({ data: { ...base, title: 'Ended project', slug: 'ended-project', garden: garden.documentId, date_end: '2020-01-01' } });
  const farRows = Array.from({ length: 101 }, (_, index) => ({ documentId: 'distantpublicevent' + index, title: 'Distant workday ' + index, publishedAt: new Date(now).toISOString(), startDatetime: new Date(now + (index + 10) * 86400000).toISOString(), accessibility: 'Public', canceled: false, disabled: false }));
  await strapi.db.query(EVENT).createMany({ data: farRows });
  nextWorkday = await strapi.documents(EVENT).create({ status: 'published', data: { title: 'Actual next workday', startDatetime: new Date(now + 3600000).toISOString(), accessibility: 'Public', garden: garden.documentId, projects: [approved.documentId] } });
}, 120000);

afterAll(async () => { await cleanupStrapi(); });
afterEach(() => restoreAll());
function http() { return request(strapi.server.httpServer); }

it('returns a published garden with id-only volunteers, safe counts and approximate coordinates', async () => {
  const res = await http().get('/api/public/gardens').expect(200);
  expect(res.body.data.map(item => item.documentId)).toEqual([garden.documentId]);
  expect(res.body.meta.pagination.total).toBe(1);
  const item = res.body.data[0];
  expect(Object.keys(item).sort()).toEqual(['documentId', 'slug', 'title', 'blurb', 'hero_image', 'volunteers', 'activeProjectCount', 'nextWorkday', 'latitude', 'longitude', 'location_approximate'].sort());
  expect(item.volunteers).toEqual([{ id: user.id }]);
  expect(item.activeProjectCount).toBe(2);
  expect(item.latitude).toBeCloseTo(37.815, 8);
  expect(item.longitude).toBeCloseTo(-122.235, 8);
  expect(item.latitude).not.toBe(37.812345);
  expect(item.longitude).not.toBe(-122.234567);
  expect(item.location_approximate).toBe(true);
  expect(item.nextWorkday).toEqual({ id: nextWorkday.id, documentId: nextWorkday.documentId, startDatetime: nextWorkday.startDatetime });
  expect(JSON.stringify(res.body)).not.toMatch(/DIRECTORY_PRIVATE_SENTINEL|private-volunteer@|14155550123/);
});

it('finds the actual next garden workday beyond the first100 descending feed entries', async () => {
  const feed = await http().get('/api/volunteer-days/public?pagination[pageSize]=100').expect(200);
  expect(feed.body.data.some(item => item.documentId === nextWorkday.documentId)).toBe(false);
  const res = await http().get('/api/public/gardens').expect(200);
  expect(res.body.data[0].nextWorkday.documentId).toBe(nextWorkday.documentId);
});

it('returns approved/completed projects, ordered real gallery, public context and no contacts', async () => {
  const res = await http().get('/api/public/projects').expect(200);
  const ids = res.body.data.map(item => item.documentId);
  expect(ids).toEqual(expect.arrayContaining([approved.documentId, gardenless.documentId, completed.documentId]));
  expect(res.body.data.some(item => item.title.startsWith('Hidden'))).toBe(false);
  expect(res.body.meta.pagination.total).toBe(4);
  const item = res.body.data.find(item => item.documentId === approved.documentId);
  expect(Object.keys(item).sort()).toEqual(['id', 'documentId', 'slug', 'title', 'short_description', 'date_start', 'date_end', 'review_status', 'category', 'hero_image', 'featured_gallery', 'garden', 'interested', 'related_events'].sort());
  expect(item.id).toBe(approved.id);
  expect(item.interested).toEqual([{ id: user.id }]);
  expect(item.garden.title).toBe('Published garden');
  expect(item.featured_gallery.map(image => image.url)).toEqual(['/uploads/gallery-second.jpg', '/uploads/gallery.jpg']);
  expect(item.related_events).toEqual([{ id: nextWorkday.id, documentId: nextWorkday.documentId, startDatetime: nextWorkday.startDatetime }]);
  expect(JSON.stringify(res.body)).not.toMatch(/DIRECTORY_PRIVATE_SENTINEL|private-submitter@|private-volunteer@|14155550123/);
});

it.each(['/api/public/gardens', '/api/public/projects'])('has caller-independent public output at %s', async path => {
  const anonymous = await http().get(path).expect(200);
  const signedIn = await http().get(path).set('Authorization', 'Bearer ' + token).expect(200);
  const invalid = await http().get(path).set('Authorization', 'Bearer invalid-token').expect(200);
  expect(signedIn.body).toEqual(anonymous.body);
  expect(invalid.body).toEqual(anonymous.body);
});

it.each(['/api/public/gardens', '/api/public/projects'])('rejects caller-selected fields and supports accurate pagination at %s', async path => {
  for (const query of ['populate=*', 'fields[0]=welcome_text', 'filters[title]=x', 'sort=title', 'pagination[page]=1&pagination[page]=2']) await http().get(path + '?' + query).expect(400);
  const first = await http().get(path + '?pagination[pageSize]=1').expect(200);
  expect(first.body.data).toHaveLength(1);
  const beyond = await http().get(path + '?pagination[page]=20&pagination[pageSize]=1').expect(200);
  expect(beyond.body.data).toEqual([]);
  expect(beyond.body.meta.pagination.total).toBe(first.body.meta.pagination.total);
});


it('returns generic failures without leaking service error details', async () => {
  patchService('api::project.public-directory', 'list', async () => { throw new Error(SENTINEL); });
  const res = await http().get('/api/public/projects').expect(500);
  expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
});

it('normalizes absent and invalid garden locations and empty relations', async () => {
  const empty = await strapi.documents(GARDEN).create({ status: 'published', data: { title: 'Empty garden', slug: 'empty-garden', sms_slug: 'empty-directory' } });
  const res = await http().get('/api/public/gardens').expect(200);
  const card = res.body.data.find(item => item.documentId === empty.documentId);
  expect(card.volunteers).toEqual([]);
  expect(card.activeProjectCount).toBe(0);
  expect(card.nextWorkday).toBeNull();
  expect(card.hero_image).toBeNull();
  expect(card.latitude).toBeNull();
  expect(card.longitude).toBeNull();
  await strapi.db.query(GARDEN).updateMany({ where: { documentId: empty.documentId }, data: { latitude: 100, longitude: 0 } });
  const invalid = await http().get('/api/public/gardens').expect(200);
  const invalidCard = invalid.body.data.find(item => item.documentId === empty.documentId);
  expect(invalidCard.latitude).toBeNull();
  expect(invalidCard.longitude).toBeNull();
});

it('reports accurate empty public collections rather than failed reads', async () => {
  const gardens = await strapi.documents(GARDEN).findMany({ status: 'published' });
  for (const item of gardens) await strapi.documents(GARDEN).unpublish({ documentId: item.documentId });
  await strapi.db.query(PROJECT).updateMany({ where: { review_status: { $in: ['APPROVED', 'COMPLETED'] } }, data: { review_status: 'ARCHIVED' } });
  for (const path of ['/api/public/gardens', '/api/public/projects']) {
    const res = await http().get(path).expect(200);
    expect(res.body).toEqual({ data: [], meta: { pagination: { page: 1, pageSize: 24, pageCount: 0, total: 0 } } });
  }
});
