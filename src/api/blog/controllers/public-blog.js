'use strict';

const { errors } = require('@strapi/utils');
const { publicPagination, publicSlug } = require('../../../utils/public-input');

module.exports = {
  async list(ctx) {
    ctx.body = await strapi.service('api::blog.public-blog').list(publicPagination(ctx));
  },
  async detail(ctx) {
    if (ctx.request.querystring) throw new errors.ValidationError('Unsupported query parameter');
    if (!publicSlug(ctx.params.slug)) return ctx.notFound('Article not found');
    const article = await strapi.service('api::blog.public-blog').detail(ctx.params.slug);
    if (!article) return ctx.notFound('Article not found');
    ctx.body = article;
  },
};
