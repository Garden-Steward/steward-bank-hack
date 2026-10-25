'use strict';

const { errors } = require('@strapi/utils');
const createHttp = require('./http');

const EVENT = 'api::volunteer-day.volunteer-day';

module.exports = ({ strapi }) => {
  const table = () => strapi.db.metadata.get('api::participation.participation').tableName;
  function populate(uid, value, depth = 0) {
    if (!value) return value;
    if (depth > 8) throw new errors.ValidationError('Populate is too deep');
    const model = strapi.getModel(uid);
    if (!model) throw new errors.ValidationError('Unsupported population');
    let entries = value;
    if (value === '*' || value === true || value === 'true') {
      entries = {};
      for (const [name, attribute] of Object.entries(model.attributes)) {
        if (['relation', 'media', 'component', 'dynamiczone'].includes(attribute.type)) entries[name] = true;
      }
    } else if (typeof value === 'string' || Array.isArray(value)) {
      entries = {};
      let paths = value;
      if (typeof value === 'string') paths = value.split(',');
      for (const path of paths) {
        let current = entries;
        const parts = String(path).split('.');
        for (let index = 0; index < parts.length; index++) {
          const name = parts[index];
          if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new errors.ValidationError('Unsupported population');
          if (index === parts.length - 1) current[name] = true;
          else { if (!current[name] || current[name] === true) current[name] = { populate: {} }; current = current[name].populate; }
        }
      }
    }
    const result = {};
    for (const [name, options] of Object.entries(entries)) {
      if (['__proto__', 'prototype', 'constructor'].includes(name) || !Object.hasOwn(model.attributes, name)) throw new errors.ValidationError('Unsupported population');
      if (uid === EVENT && name === 'confirmed') continue;
      const attribute = model.attributes[name];
      if (options && typeof options === 'object' && !Array.isArray(options)) {
        const clean = { ...options };
        let target;
        if (attribute) target = attribute.target || attribute.component;
        if (target && Object.hasOwn(clean, 'populate')) clean.populate = populate(target, clean.populate, depth + 1);
        if (target && clean.filters) rejectNestedConfirmed(target, clean.filters);
        if (clean.on) {
          clean.on = {};
          for (const [component, fields] of Object.entries(options.on)) {
            if (['__proto__', 'prototype', 'constructor'].includes(component)) throw new errors.ValidationError('Unsupported population');
            clean.on[component] = { ...fields };
            if (fields.filters) rejectNestedConfirmed(component, fields.filters);
            if (fields.populate) clean.on[component].populate = populate(component, fields.populate, depth + 1);
          }
        }
        result[name] = clean;
      } else result[name] = options;
    }
    return result;
  }
  function rejectNestedConfirmed(uid, filters, depth = 0) {
    if (!filters || typeof filters !== 'object') return;
    if (depth > 12) throw new errors.ValidationError('Filters are too deep');
    for (const [key, value] of Object.entries(filters)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new errors.ValidationError('Unsupported filter');
      if (uid === EVENT && key === 'confirmed') throw new errors.ValidationError('Only the current actor RSVP filter is supported');
      const attribute = strapi.getModel(uid)?.attributes[key];
      let target = uid;
      if (attribute?.target) target = attribute.target;
      rejectNestedConfirmed(target, value, depth + 1);
    }
  }
  async function prepareQuery(params, actorId) {
    const result = { ...params };
    let filters = { ...params.filters };
    if (Object.hasOwn(filters, 'confirmed')) {
      const requested = filters.confirmed;
      if (!actorId || !requested || Object.keys(requested).join() !== 'id' || !requested.id || Object.keys(requested.id).join() !== '$eq' || String(requested.id.$eq) !== String(actorId)) {
        throw new errors.ValidationError('Only the current actor RSVP filter is supported');
      }
      delete filters.confirmed;
      rejectNestedConfirmed(EVENT, filters);
      const rows = await strapi.db.connection(table()).select('event_document_id').where({ user_id: actorId, rsvp_state: 'confirmed' });
      filters = { $and: [filters, { documentId: { $in: rows.map(row => row.event_document_id) } }] };
    } else rejectNestedConfirmed(EVENT, filters);
    result.filters = filters;
    if (result.populate) result.populate = populate(EVENT, result.populate);
    return result;
  }
  async function project(entries, actorId) {
    if (!entries.length) return entries;
    const ids = [...new Set(entries.map(row => row.documentId).filter(Boolean))];
    const rows = await strapi.db.connection(table()).select('event_document_id', 'user_id').whereIn('event_document_id', ids).where({ rsvp_state: 'confirmed' });
    const counts = new Map(); const own = new Set();
    for (const row of rows) {
      counts.set(row.event_document_id, (counts.get(row.event_document_id) || 0) + 1);
      if (row.user_id === actorId) own.add(row.event_document_id);
    }
    return entries.map(row => {
      const result = { ...row, confirmedCount: counts.get(row.documentId) || 0, confirmed: [] };
      if (own.has(row.documentId)) result.confirmed = [{ id: actorId }];
      return result;
    });
  }
  return {
    populate, prepareQuery, project, rejectNestedConfirmed,
    async visibility(actorId) {
      const publicEvents = { publishedAt: { $notNull: true }, accessibility: 'Public', garden: { publishedAt: { $notNull: true } } };
      if (!actorId) return publicEvents;
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: actorId }, populate: ['role'] });
      if (user?.role?.type === 'administrator') return {};
      const gardens = await strapi.db.query('api::garden.garden').findMany({ where: { managers: { id: actorId } }, select: ['documentId'] });
      return { $or: [publicEvents, { garden: { documentId: { $in: [...new Set(gardens.map(row => row.documentId))] } } }] };
    },
    async optionalActor(ctx) {
      try { return await createHttp({ strapi }).actor(ctx); } catch { return null; }
    },
    async importConfirmed() {
      const pairs = new Map(); let cursor = 0; let scanned = 0;
      while (true) {
        const rows = await strapi.db.query(EVENT).findMany({
          where: { id: { $gt: cursor } }, orderBy: { id: 'asc' }, limit: 200,
          select: ['id', 'documentId', 'publishedAt'], populate: { confirmed: { select: ['id'] }, garden: { select: ['documentId'] } },
        });
        for (const row of rows) {
          scanned++;
          if (scanned > 5000) throw new Error('Legacy RSVP cutover exceeds its bounded batch');
          for (const user of row.confirmed || []) {
            const key = row.documentId + ':' + user.id;
            const previous = pairs.get(key);
            if (!previous || (row.publishedAt && row.garden)) pairs.set(key, { eventDocumentId: row.documentId, gardenDocumentId: row.garden?.documentId, userId: user.id });
          }
        }
        if (rows.length < 200) break;
        cursor = rows[rows.length - 1].id;
      }
      if ([...pairs.values()].some(row => !row.gardenDocumentId)) throw new Error('Legacy RSVP cutover needs an existing garden identity');
      return strapi.service('api::auth.join-identity').withTransaction(async trx => {
        let created = 0;
        const observedAt = new Date().toISOString();
        for (const pair of pairs.values()) {
          const exists = await trx(table()).select('id').where({ event_document_id: pair.eventDocumentId, user_id: pair.userId }).first();
          if (exists) continue;
          await strapi.db.query('api::participation.participation').create({ data: {
            ...pair, receiptId: require('node:crypto').randomBytes(32).toString('hex'), rsvpState: 'confirmed', rsvpedAt: observedAt,
            joinSnapshotJson: { source: 'legacy_import', rsvpTimeKnown: false, observedAt },
          } });
          created++;
        }
        await strapi.store({ type: 'plugin', name: 'participation', key: 'cutover-v1' }).set({ value: { version: 1 } });
        return { observed: pairs.size, created };
      });
    },
  };
};
