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

const forbiddenSlugCharacters = [
  ...Array.from({ length: 33 }, (_, code) => String.fromCharCode(code)),
  '\u007f', '\u00a0', '\u1680',
  ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
  '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '/', '\\', '?', '#',
];

function publicSlug(value) {
  return typeof value === 'string' && value.length > 0 && !forbiddenSlugCharacters.some(character => value.includes(character));
}

function slugFilters(strapi, uid) {
  const { tableName, attributes } = strapi.db.metadata.get(uid);
  const column = attributes.slug.columnName;
  const query = strapi.db.getConnection(tableName).select(column).whereNotNull(column).whereNot(column, '');
  const postgres = strapi.db.config.connection.client === 'postgres';
  let position = 'instr';
  if (postgres) position = 'strpos';
  for (const character of forbiddenSlugCharacters) {
    // PostgreSQL text cannot contain NUL; SQLite needs instr because LIKE truncates at NUL.
    if (postgres && character === '\u0000') continue;
    query.whereRaw(position + '(??, ?) = 0', [column, character]);
  }
  return { slug: { $in: query } };
}

module.exports = { publicPagination, publicPage, publicSlug, slugFilters };
