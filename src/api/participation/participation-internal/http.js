'use strict';

const problem = require('./problem');
const failures = {
  IDENTITY_REQUEST_CONFLICT: [409, 'REQUEST_CONFLICT'],
  IDENTITY_ACCOUNT_CHANGED: [409, 'ACCOUNT_CHANGED'],
  IDENTITY_ACTOR_UNAVAILABLE: [409, 'ACCOUNT_CHANGED'],
  IDENTITY_ACCOUNT_UNAVAILABLE: [409, 'ACCOUNT_UNAVAILABLE'],
  IDENTITY_COLLISION: [409, 'ACCOUNT_UNAVAILABLE'],
  IDENTITY_PROOF_UNAVAILABLE: [400, 'INVALID_PROOF'],
  IDENTITY_SCOPE_UNAVAILABLE: [400, 'INVALID_PROOF'],
  IDENTITY_FRESH_PROOF_REQUIRED: [400, 'INVALID_PROOF'],
};

module.exports = ({ strapi }) => ({
  async actor(ctx, required = false) {
    const header = ctx.request.headers.authorization;
    if (header === undefined) {
      if (required) problem('INVALID_SESSION', 401);
      return null;
    }
    if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) problem('INVALID_SESSION', 401);
    let payload;
    try { payload = await strapi.plugin('users-permissions').service('jwt').verify(header.slice(7)); }
    catch { problem('INVALID_SESSION', 401); }
    if (!Number.isSafeInteger(payload.id) || payload.id < 1) problem('INVALID_SESSION', 401);
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: payload.id }, select: ['id', 'blocked'] });
    if (!user || user.blocked) problem('INVALID_SESSION', 401);
    return user.id;
  },
  async session(userId) {
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: userId }, select: ['id', 'username', 'blocked'], populate: ['role'] });
    if (!user || user.blocked || !user.role) problem('INVALID_SESSION', 401);
    const jwt = await strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });
    return { jwt, user: { id: user.id, username: user.username, role: { id: user.role.id, name: user.role.name, type: user.role.type } } };
  },
  async run(ctx, operation) {
    ctx.set('Cache-Control', 'no-store');
    if (process.env.PARTICIPATION_ENABLED !== 'true') {
      ctx.status = 404; ctx.body = { error: { code: 'NOT_FOUND', message: 'Not found.' } }; return;
    }
    try { await operation(); }
    catch (error) {
      let status = error.status;
      let code = error.code;
      if (Object.hasOwn(failures, code)) [status, code] = failures[code];
      if (!Number.isInteger(status) || status < 400 || status >= 500) {
        strapi.log.error('[participation] request failed');
        status = 500; code = 'INTERNAL_ERROR';
      }
      if (status === 429) ctx.set('Retry-After', '60');
      let message = 'We could not save this yet. Please try again.';
      if (status === 401) message = 'Please sign in again.';
      if (status === 404) message = 'Not found.';
      if (code === 'INVALID_PROOF') message = 'That code is invalid or has expired.';
      if (code === 'EVENT_UNAVAILABLE') message = 'This event is no longer open for joining.';
      ctx.status = status;
      ctx.body = { error: { code, message, fieldErrors: error.fieldErrors || {} } };
    }
  },
});
