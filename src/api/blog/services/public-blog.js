'use strict';

const { publicMedia, mediaFields } = require('../../../utils/public-media');
const { publicPage, slugFilters } = require('../../../utils/public-input');
const { publicBlocks } = require('../utils/public-blocks');
const UID = 'api::blog.blog';
const cardFields = ['slug', 'title', 'excerpt', 'article_date', 'publishedAt'];
const cardPopulate = { hero: { fields: mediaFields }, category: { fields: ['title', 'publishedAt'] } };

function publicCard(blog) {
  let category = null;
  if (blog.category?.publishedAt) category = { title: blog.category.title ?? null };
  return {
    id: blog.id,
    documentId: blog.documentId,
    slug: blog.slug,
    title: blog.title ?? null,
    excerpt: blog.excerpt ?? null,
    article_date: blog.article_date ?? null,
    publishedAt: blog.publishedAt,
    hero: publicMedia(blog.hero),
    category,
  };
}

function publicAuthor(author) {
  if (!author) return null;
  return { firstName: author.firstName ?? null, lastName: author.lastName ?? null, profilePhoto: publicMedia(author.profilePhoto) };
}

function blogUrl(blog) {
  if (!blog) return null;
  return '/blog/' + encodeURIComponent(blog.slug);
}

module.exports = ({ strapi }) => ({
  async list(pagination) {
    const filters = slugFilters(strapi, UID);
    const [blogs, total] = await Promise.all([
      strapi.documents(UID).findMany({ status: 'published', filters, fields: cardFields, populate: cardPopulate, sort: ['createdAt:desc', 'documentId:asc'], start: pagination.start, limit: pagination.limit }),
      strapi.documents(UID).count({ status: 'published', filters }),
    ]);
    return publicPage(blogs.map(publicCard), total, pagination);
  },

  async detail(slug) {
    const authors = { fields: ['firstName', 'lastName'], populate: { profilePhoto: { fields: mediaFields } } };
    const blogs = await strapi.documents(UID).findMany({
      status: 'published', filters: { $and: [slugFilters(strapi, UID), { slug }] },
      fields: [...cardFields, 'subtitle', 'content', 'hero_display', 'createdAt'],
      populate: {
        ...cardPopulate, author: authors, co_author: authors,
        plants: { fields: ['title', 'latin', 'slug', 'publishedAt'], filters: { publishedAt: { $notNull: true } }, populate: { clipart: { fields: mediaFields } } },
      },
      sort: ['createdAt:desc', 'documentId:asc'], limit: 1,
    });
    if (!blogs.length) return null;
    const blog = blogs[0];
    const [before, after] = await Promise.all([
      strapi.documents(UID).findMany({
        status: 'published', fields: ['slug'],
        filters: { $and: [slugFilters(strapi, UID), { $or: [{ createdAt: { $gt: blog.createdAt } }, { createdAt: blog.createdAt, documentId: { $lt: blog.documentId } }] }] },
        sort: ['createdAt:asc', 'documentId:desc'], limit: 1,
      }),
      strapi.documents(UID).findMany({
        status: 'published', fields: ['slug'],
        filters: { $and: [slugFilters(strapi, UID), { $or: [{ createdAt: { $lt: blog.createdAt } }, { createdAt: blog.createdAt, documentId: { $gt: blog.documentId } }] }] },
        sort: ['createdAt:desc', 'documentId:asc'], limit: 1,
      }),
    ]);
    const excluded = [blog.documentId];
    if (before[0]) excluded.push(before[0].documentId);
    if (after[0]) excluded.push(after[0].documentId);
    const randomFilters = { $and: [slugFilters(strapi, UID), { documentId: { $notIn: excluded } }] };
    const eligible = await strapi.documents(UID).count({ status: 'published', filters: randomFilters });
    let random = null;
    if (eligible) {
      const rows = await strapi.documents(UID).findMany({ status: 'published', fields: ['slug'], filters: randomFilters, sort: ['createdAt:desc', 'documentId:asc'], start: Math.floor(Math.random() * eligible), limit: 1 });
      random = blogUrl(rows[0]);
    }
    return {
      ...publicCard(blog),
      subtitle: blog.subtitle ?? null,
      content: publicBlocks(blog.content),
      hero_display: blog.hero_display !== false,
      author: publicAuthor(blog.author),
      co_author: publicAuthor(blog.co_author),
      plants: (blog.plants || []).filter(plant => plant.publishedAt).map(plant => ({ id: plant.id, documentId: plant.documentId, title: plant.title ?? null, latin: plant.latin ?? null, slug: plant.slug ?? null, clipart: publicMedia(plant.clipart) })),
      prev_blog_post: blogUrl(before[0]),
      next_blog_post: blogUrl(after[0]),
      random_post: random,
    };
  },
});
