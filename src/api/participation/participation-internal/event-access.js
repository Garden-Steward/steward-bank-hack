'use strict';

const problem = require('./problem');

module.exports = ({ strapi }) => {
  const lock = query => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') query.forUpdate();
    return query;
  };
  async function published(trx, uid, documentId, writable) {
    const table = strapi.db.metadata.get(uid).tableName;
    const builder = trx(table).select('id').where({ document_id: documentId }).whereNotNull('published_at').limit(2);
    if (writable) lock(builder);
    const rows = await builder;
    if (rows.length !== 1) problem('EVENT_NOT_FOUND', 404);
    return rows[0];
  }
  const read = async (trx, documentId, { joining = true } = {}) => {
    if (typeof documentId !== 'string' || !/^[a-z0-9]{10,40}$/i.test(documentId)) problem('EVENT_NOT_FOUND', 404);
    const row = await published(trx, 'api::volunteer-day.volunteer-day', documentId, joining);
    const event = await strapi.db.query('api::volunteer-day.volunteer-day').findOne({ where: { id: row.id }, populate: { garden: { select: ['documentId'] } } });
    if (!event || event.accessibility !== 'Public' || !event.garden?.documentId) problem('EVENT_NOT_FOUND', 404);
    const gardenRow = await published(trx, 'api::garden.garden', event.garden.documentId, joining);
    const garden = await strapi.db.query('api::garden.garden').findOne({ where: { id: gardenRow.id }, select: ['id', 'documentId', 'title', 'slug'] });
    if (joining && (event.canceled || event.disabled || !event.startDatetime || new Date(event.startDatetime).getTime() <= Date.now() || event.partiful_link)) problem('EVENT_UNAVAILABLE', 409);
    return {
      event, garden,
      safe: { documentId: event.documentId, title: event.title, startDatetime: event.startDatetime, eventPath: '/d/' + event.documentId, garden: { documentId: garden.documentId, title: garden.title, slug: garden.slug } },
    };
  };
  read.fence = (trx, query, context) => {
    const events = strapi.db.metadata.get('api::volunteer-day.volunteer-day').tableName;
    const gardens = strapi.db.metadata.get('api::garden.garden').tableName;
    const client = strapi.db.connection.client.config.client;
    let now = trx.raw("(julianday('now') - 2440587.5) * 86400000");
    if (client === 'pg' || client === 'postgres') now = trx.raw('clock_timestamp()');
    return query.whereExists(function () {
      this.select(trx.raw('1')).from(events).where({ id: context.event.id, accessibility: 'Public' }).whereNotNull('published_at')
        .where('start_datetime', '>', now)
        .where(function () { this.where('canceled', false).orWhereNull('canceled'); })
        .where(function () { this.where('disabled', false).orWhereNull('disabled'); })
        .where(function () { this.whereNull('partiful_link').orWhere('partiful_link', ''); });
    }).whereExists(function () {
      this.select(trx.raw('1')).from(gardens).where({ id: context.garden.id }).whereNotNull('published_at');
    });
  };
  return read;
};
