'use strict';

process.env.DATABASE_FILENAME = '.tmp/public-projection-regression-16.db';
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
const BLOG = 'api::blog.blog';
const GARDEN = 'api::garden.garden';
const SENTINEL = 'MALFORMED_MEDIA_PRIVATE_SENTINEL';

beforeAll(async () => { await setupStrapi(); }, 120000);
afterAll(async () => { await cleanupStrapi(); });
function http() { return request(strapi.server.httpServer); }

it('projects historical image scalars without copying nested private data', async () => {
  const article = await strapi.documents(BLOG).create({ status: 'published', data: { title: 'Historical image', slug: 'historical-image', content: [] } });
  const alternatives = [{ email: SENTINEL }, [SENTINEL], 17, false, null, '', '  A garden  '];
  const content = alternatives.map(alternativeText => ({ type: 'image', image: {
    url: '/uploads/history.jpg', alternativeText, width: { private: SENTINEL }, height: [SENTINEL],
    formats: { small: { url: '/uploads/small.jpg', width: { private: SENTINEL }, height: [SENTINEL], extra: SENTINEL } },
  }, children: [{ type: 'text', text: '' }] }));
  await strapi.db.query(BLOG).update({ where: { id: article.id }, data: { content } });
  try {
    const response = await http().get('/api/public/blogs/historical-image').expect(200);
    expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
    expect(response.body.content.map(block => block.image.alternativeText)).toEqual([null, null, null, null, null, '', '  A garden  ']);
    for (const block of response.body.content) {
      expect(block.image.width).toBeNull();
      expect(block.image.height).toBeNull();
      expect(block.image.formats).toEqual({ small: { url: '/uploads/small.jpg', width: null, height: null } });
    }
  } finally {
    await strapi.documents(BLOG).delete({ documentId: article.documentId });
  }
});

it('excludes unroutable slugs from lists, exact totals and every navigation target', async () => {
  const invalidCharacters = [String.fromCharCode(...[]), ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(index)), '\u007f', '\u00a0', '\u1680', ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)), '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '/', String.fromCharCode(92), '?', '#'].filter(Boolean);
  const createdBlogs = [];
  const createdGardens = [];
  const validSlugs = ['first-story', 'notes-été', 'a%percent', '故事', 'fifth-story', 'sixth-story'];
  try {
    let index = 0;
    for (const character of invalidCharacters) {
      const slug = 'bad' + character + 'slug-' + index;
      createdBlogs.push(await strapi.documents(BLOG).create({ status: 'published', data: { title: 'Unroutable ' + index, slug, content: [] } }));
      if (['\u0000', '\u000b', '\u00a0', '\u007f', '\u3000'].includes(character)) {
        createdGardens.push(await strapi.documents(GARDEN).create({ status: 'published', data: { title: 'Unroutable garden ' + index, slug, sms_slug: 'invalid-review-' + index } }));
      }
      index++;
    }
    for (const slug of validSlugs) {
      createdBlogs.push(await strapi.documents(BLOG).create({ status: 'published', data: { title: 'Valid story', slug, content: [] } }));
    }
    createdGardens.push(await strapi.documents(GARDEN).create({ status: 'published', data: { title: 'Valid garden', slug: 'valid-garden', sms_slug: 'valid-review' } }));
    const list = await http().get('/api/public/blogs?pagination[pageSize]=2').expect(200);
    expect(list.body.meta.pagination).toEqual({ page: 1, pageSize: 2, pageCount: 3, total: validSlugs.length });
    const all = [];
    for (let page = 1; page <= 3; page++) {
      const response = await http().get('/api/public/blogs?pagination[pageSize]=2&pagination[page]=' + page).expect(200);
      all.push(...response.body.data.map(article => article.slug));
    }
    expect(all.sort()).toEqual([...validSlugs].sort());
    const gardens = await http().get('/api/public/gardens').expect(200);
    expect(gardens.body.meta.pagination.total).toBe(1);
    expect(gardens.body.data.map(garden => garden.slug)).toEqual(['valid-garden']);
    for (const slug of validSlugs) {
      const detail = await http().get('/api/public/blogs/' + encodeURIComponent(slug)).expect(200);
      for (const key of ['prev_blog_post', 'next_blog_post', 'random_post']) {
        const target = detail.body[key];
        if (target) {
          expect(validSlugs.map(value => '/blog/' + encodeURIComponent(value))).toContain(target);
          await http().get('/api/public/blogs/' + target.slice('/blog/'.length)).expect(200);
        }
      }
    }
    for (const character of ['\u000b', '\u00a0', '\u007f']) {
      const article = createdBlogs.find(value => value.slug.includes(character));
      await http().get('/api/public/blogs/' + encodeURIComponent(article.slug)).expect(404);
    }
  } finally {
    for (const article of createdBlogs) await strapi.documents(BLOG).delete({ documentId: article.documentId });
    for (const garden of createdGardens) await strapi.documents(GARDEN).delete({ documentId: garden.documentId });
  }
}, 120000);
