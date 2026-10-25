'use strict';

const { errors } = require('@strapi/utils');

function publicPagination(ctx, defaultSize = 24, allowPopulate = false) {
  const values = new URLSearchParams(ctx.request.querystring || '');
  const seen = new Set();
  const pagination = { page: 1, pageSize: defaultSize };
  for (const [key, value] of values) {
    if (allowPopulate && (key === 'populate' || key.startsWith('populate['))) continue;
    if (seen.has(key)) throw new errors.ValidationError('Duplicate query parameter');
    seen.add(key);
    let field;
    if (key === 'pagination[page]') field = 'page';
    else if (key === 'pagination[pageSize]') field = 'pageSize';
    else throw new errors.ValidationError('Unsupported query parameter');
    if (!/^[1-9]\d*$/.test(value)) throw new errors.ValidationError('Invalid pagination');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new errors.ValidationError('Invalid pagination');
    pagination[field] = number;
  }
  const offset = (pagination.page - 1) * pagination.pageSize;
  if (pagination.pageSize > 100 || !Number.isSafeInteger(offset) || offset > 100000) {
    throw new errors.ValidationError('Pagination exceeds the public limit');
  }
  return { ...pagination, start: offset, limit: pagination.pageSize };
}

function publicPage(data, total, pagination) {
  return {
    data,
    meta: {
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        pageCount: Math.ceil(total / pagination.pageSize),
        total,
      },
    },
  };
}

function publicSlug(value) {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\?#\u0000-\u001f\u007f]/u.test(value);
}

function slugFilters() {
  return {
    $and: [
      { slug: { $notNull: true, $ne: '' } },
      ...[' ', '\t', '\r', '\n', '/', '\\', '?', '#'].map(value => ({ slug: { $notContains: value } })),
    ],
  };
}

module.exports = { publicPagination, publicPage, publicSlug, slugFilters };
