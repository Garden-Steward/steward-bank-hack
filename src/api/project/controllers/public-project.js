'use strict';

const { publicPagination } = require('../../../utils/public-input');

module.exports = {
  async list(ctx) {
    ctx.body = await strapi.service('api::project.public-directory').list(publicPagination(ctx));
  },
};
