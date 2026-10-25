'use strict';

process.env.DATABASE_FILENAME = '.tmp/public-reads-blog.db';
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
const { publicBlocks } = require('../../src/api/blog/utils/public-blocks');
const { publicMedia, publicUrl } = require('../../src/utils/public-media');
const BLOG = 'api::blog.blog';
const SENTINEL = 'BLOG_PRIVATE_SENTINEL';
let article;
let media;
let author;
let token;

beforeAll(async () => {
  await setupStrapi();
  const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'public' } });
  const permissions = await strapi.db.query('plugin::users-permissions.permission').findMany({ where: { role: publicRole.id } });
  for (const permission of permissions) await strapi.db.query('plugin::users-permissions.permission').delete({ where: { id: permission.id } });
  const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  author = await strapi.db.query('plugin::users-permissions.user').create({ data: { username: 'private-author@example.test', email: 'private-author@example.test', phoneNumber: '+14155550189', firstName: '  Jo  ', lastName: 'Mc Garden', bio: SENTINEL, role: role.id, confirmed: true, provider: 'local' } });
  token = strapi.plugin('users-permissions').service('jwt').issue({ id: author.id });
  media = await strapi.db.query('plugin::upload.file').create({ data: { name: 'blog.jpg', hash: 'blog', mime: 'image/jpeg', size: 1, url: '/uploads/blog.jpg', provider: 'local', alternativeText: '', formats: { small: { url: '/uploads/blog-small.jpg', width: 100, height: 60, private: SENTINEL } }, provider_metadata: { private: SENTINEL } } });
  const category = await strapi.documents('api::category.category').create({ status: 'published', data: { title: 'Garden notes' } });
  const plant = await strapi.documents('api::plant.plant').create({ status: 'published', data: { title: 'Mint', slug: 'mint', latin: 'Mentha', clipart: media.id } });
  article = await strapi.documents(BLOG).create({ status: 'published', data: { title: 'A published article', slug: 'published-article', excerpt: 'Published text', subtitle: 'Public subtitle', article_date: '2026-10-20', hero: media.id, hero_display: true, author: author.id, category: category.documentId, plants: [plant.documentId], content: [] } });
  const image = { ...media, private: SENTINEL, provider_metadata: { private: SENTINEL } };
  await strapi.db.query(BLOG).update({ where: { id: article.id }, data: { content: [
    { type: 'paragraph', private: SENTINEL, children: [{ type: 'text', text: 'Published editorial text', bold: true, italic: false, underline: true, strikethrough: true, code: true, private: SENTINEL }, { type: 'link', url: '/gardens', private: SENTINEL, children: [{ type: 'text', text: 'Gardens', private: SENTINEL }] }] },
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading' }], private: SENTINEL },
    { type: 'quote', children: [{ type: 'text', text: 'A thought' }] },
    { type: 'code', children: [{ type: 'text', text: '<safe code>' }] },
    { type: 'list', format: 'unordered', children: [{ type: 'list-item', children: [{ type: 'text', text: 'First' }] }, { type: 'list', format: 'ordered', children: [{ type: 'list-item', children: [{ type: 'text', text: 'Nested' }] }] }] },
    { type: 'image', image, children: [{ type: 'text', text: '' }], private: SENTINEL },
    { type: 'unsupported', private: SENTINEL, children: [] },
  ] } });
  await strapi.documents(BLOG).create({ data: { title: 'Hidden draft', slug: 'hidden-draft', content: [] } });
}, 120000);

afterAll(async () => { await cleanupStrapi(); });
function http() { return request(strapi.server.httpServer); }

it('lists only published cards without allowing raw Blog core access', async () => {
  const res = await http().get('/api/public/blogs').expect(200);
  expect(res.body.data.map(item => item.documentId)).toEqual([article.documentId]);
  expect(Object.keys(res.body.data[0]).sort()).toEqual(['id', 'documentId', 'slug', 'title', 'excerpt', 'article_date', 'publishedAt', 'hero', 'category'].sort());
  expect(res.body.data[0].category).toEqual({ title: 'Garden notes' });
  expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  const core = await http().get('/api/blogs');
  const legacy = await http().get('/api/blogs/published-article/full');
  expect([401, 403]).toContain(core.status);
  expect([401, 403]).toContain(legacy.status);
});

it('returns explicit authors and recursively projected supported blocks', async () => {
  const res = await http().get('/api/public/blogs/published-article').expect(200);
  expect(Object.keys(res.body).sort()).toEqual(['id', 'documentId', 'slug', 'title', 'excerpt', 'article_date', 'publishedAt', 'hero', 'category', 'subtitle', 'content', 'hero_display', 'author', 'co_author', 'plants', 'prev_blog_post', 'next_blog_post', 'random_post'].sort());
  expect(res.body.author).toEqual({ firstName: '  Jo  ', lastName: 'Mc Garden', profilePhoto: null });
  expect(res.body.co_author).toBeNull();
  expect(res.body.plants).toHaveLength(1);
  expect(Object.keys(res.body.plants[0]).sort()).toEqual(['id', 'documentId', 'title', 'latin', 'slug', 'clipart'].sort());
  expect(res.body.content.map(node => node.type)).toEqual(['paragraph', 'heading', 'quote', 'code', 'list', 'image']);
  expect(res.body.content[0].children[0]).toEqual({ type: 'text', text: 'Published editorial text', bold: true, italic: false, underline: true, strikethrough: true, code: true });
  expect(res.body.content[4].children[1].children[0]).toEqual({ type: 'list-item', children: [{ type: 'text', text: 'Nested' }] });
  expect(res.body.content[5].image.formats).toEqual({ small: { url: '/uploads/blog-small.jpg', width: 100, height: 60 } });
  expect(res.body.content[5].children).toEqual([{ type: 'text', text: '' }]);
  expect(JSON.stringify(res.body)).not.toMatch(/BLOG_PRIVATE_SENTINEL|private-author@|14155550189|createdBy|provider_metadata/);
});

it('keeps the same public shape with valid and invalid bearer headers', async () => {
  const anonymous = await http().get('/api/public/blogs/published-article').expect(200);
  const signed = await http().get('/api/public/blogs/published-article').set('Authorization', 'Bearer ' + token).expect(200);
  const invalid = await http().get('/api/public/blogs/published-article').set('Authorization', 'Bearer invalid-token').expect(200);
  expect(signed.body).toEqual(anonymous.body);
  expect(invalid.body).toEqual(anonymous.body);
});

it('returns indistinguishable404 for missing, malformed and draft-only articles', async () => {
  const missing = await http().get('/api/public/blogs/missing-article').expect(404);
  const draft = await http().get('/api/public/blogs/hidden-draft').expect(404);
  const malformed = await http().get('/api/public/blogs/bad%20slug').expect(404);
  expect(draft.body).toEqual(missing.body);
  expect(malformed.body).toEqual(missing.body);
  await http().get('/api/public/blogs/published-article?populate=*').expect(400);
});

it.each(['populate=*', 'fields[0]=author', 'sort=title', 'filters[slug]=x', 'pagination[pageSize]=101', 'pagination[page]=1&pagination[page]=2'])('rejects unsafe Blog list input %s', async query => {
  await http().get('/api/public/blogs?' + query).expect(400);
});

it.each([0, 1, 2, 3, 4])('terminates and returns available neighbors with%s published posts', async size => {
  const existing = await strapi.documents(BLOG).findMany({ status: 'published' });
  for (const item of existing) await strapi.documents(BLOG).delete({ documentId: item.documentId });
  const entries = [];
  for (let index = 0; index < size; index++) {
    const created = await strapi.documents(BLOG).create({ status: 'published', data: { title: 'Navigation ' + index, slug: 'navigation-' + index, content: [] } });
    await strapi.db.query(BLOG).updateMany({ where: { documentId: created.documentId }, data: { createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() } });
    entries.unshift(created);
  }
  const list = await http().get('/api/public/blogs?pagination[pageSize]=2').expect(200);
  expect(list.body.meta.pagination.total).toBe(size);
  if (!size) {
    expect(list.body.meta.pagination.pageCount).toBe(0);
    await http().get('/api/public/blogs/navigation-0').expect(404);
    return;
  }
  expect(list.body.data.map(item => item.documentId)).toEqual(entries.slice(0, 2).map(item => item.documentId));
  for (let index = 0; index < entries.length; index++) {
    const res = await http().get('/api/public/blogs/' + entries[index].slug).expect(200);
    let previous = null;
    let next = null;
    if (entries[index - 1]) previous = '/blog/' + entries[index - 1].slug;
    if (entries[index + 1]) next = '/blog/' + entries[index + 1].slug;
    expect(res.body.prev_blog_post).toBe(previous);
    expect(res.body.next_blog_post).toBe(next);
    const eligible = entries.map(item => '/blog/' + item.slug).filter(url => ![previous, next, '/blog/' + entries[index].slug].includes(url));
    if (eligible.length) expect(eligible).toContain(res.body.random_post);
    else expect(res.body.random_post).toBeNull();
    expect(res.body.author).toBeNull();
  }
});

it.each(['javascript:alert(1)', 'data:text/html,x', '//outside.example/x', '/\\outside.example', 'https://[', 'java\nscript:x', 'file:///private/x'])('drops unsafe editorial URL%s without exposing raw attributes', value => {
  const projected = publicBlocks([{ type: 'paragraph', children: [{ type: 'link', url: value, children: [{ type: 'text', text: 'Safe text', private: SENTINEL }] }] }]);
  expect(projected).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'Safe text' }] }]);
});

it.each(['/gardens', '#notes', 'relative/story', '../gardens', 'https://example.test/garden', 'mailto:editor@example.test', 'tel:+14155550111'])('preserves safe editorial URL%s verbatim', value => {
  expect(publicUrl(value, true)).toBe(value);
});

it('drops invalid embedded media and unapproved format keys', () => {
  expect(publicMedia({ url: '/uploads/../../private', provider_metadata: SENTINEL })).toBeNull();
  expect(publicBlocks([{ type: 'image', image: { url: 'javascript:x' }, children: [] }])).toEqual([]);
  expect(publicBlocks([{ type: 'heading', level: 100, children: [] }, { type: 'paragraph' }])).toEqual([]);
});

it('uses documentId tie-breakers for equal article dates', async () => {
  const existing = await strapi.documents(BLOG).findMany({ status: 'published' });
  for (const item of existing) await strapi.db.query(BLOG).updateMany({ where: { documentId: item.documentId }, data: { createdAt: '2026-01-01T00:00:00.000Z' } });
  const list = await http().get('/api/public/blogs').expect(200);
  const ordered = [...existing].sort((left, right) => left.documentId.localeCompare(right.documentId));
  expect(list.body.data.map(item => item.documentId)).toEqual(ordered.map(item => item.documentId));
  for (let index = 0; index < ordered.length; index++) {
    const res = await http().get('/api/public/blogs/' + ordered[index].slug).expect(200);
    let previous = null;
    let next = null;
    if (ordered[index - 1]) previous = '/blog/' + ordered[index - 1].slug;
    if (ordered[index + 1]) next = '/blog/' + ordered[index + 1].slug;
    expect(res.body.prev_blog_post).toBe(previous);
    expect(res.body.next_blog_post).toBe(next);
  }
});

it('encodes article slugs in navigation URLs and preserves valid non-ASCII slugs', async () => {
  const created = await strapi.documents(BLOG).create({ status: 'published', data: { title: 'An accented story', slug: 'notes-été', content: [] } });
  const target = await http().get('/api/public/blogs/' + encodeURIComponent(created.slug)).expect(200);
  expect(target.body.slug).toBe(created.slug);
  const list = await http().get('/api/public/blogs').expect(200);
  const adjacent = list.body.data[1];
  const other = await http().get('/api/public/blogs/' + adjacent.slug).expect(200);
  expect(other.body.prev_blog_post).toBe('/blog/' + encodeURIComponent(created.slug));
});

it('bounds recursion for malformed deeply nested editorial lists', () => {
  let nested = { type: 'list', format: 'unordered', children: [{ type: 'list-item', children: [{ type: 'text', text: 'Deep' }] }] };
  for (let depth = 0; depth < 1000; depth++) nested = { type: 'list', format: 'unordered', children: [nested] };
  const result = publicBlocks([nested]);
  expect(result).toHaveLength(1);
  expect(JSON.stringify(result).length).toBeLessThan(2500);
});
