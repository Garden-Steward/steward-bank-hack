'use strict';

const problem = require('./problem');

module.exports = ({ strapi }) => ({
  async find(trx, descriptor) {
    const table = strapi.db.metadata.get('api::participation.participation-request').tableName;
    const row = await trx(table).where({ actor_or_browser_scope: descriptor.scope, operation: descriptor.operation, request_id: descriptor.requestId }).first();
    if (!row) return null;
    if (row.request_hmac !== descriptor.requestHmac) problem('REQUEST_CONFLICT', 409);
    let result = row.safe_result_json;
    if (typeof result === 'string') result = JSON.parse(result);
    return result;
  },
  async save(descriptor, result) {
    await strapi.db.query('api::participation.participation-request').create({ data: {
      actorOrBrowserScope: descriptor.scope, operation: descriptor.operation, requestId: descriptor.requestId,
      requestHmac: descriptor.requestHmac, safeResultJson: result, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    } });
  },
});
