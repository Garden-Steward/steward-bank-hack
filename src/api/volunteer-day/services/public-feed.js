'use strict';

const { publicMedia, mediaFields } = require('../../../utils/public-media');
const { publicPage } = require('../../../utils/public-input');
const UID = 'api::volunteer-day.volunteer-day';

function visibleEventFilters(now) {
  return {
    accessibility: 'Public',
    startDatetime: { $gt: new Date(now.getTime() - 90 * 86400000).toISOString() },
    $and: [
      { $or: [{ canceled: false }, { canceled: { $null: true } }] },
      { $or: [{ disabled: false }, { disabled: { $null: true } }] },
      { $or: [{ garden: { $null: true } }, { garden: { publishedAt: { $notNull: true } } }] },
    ],
  };
}

function publicGardenRef(garden) {
  if (!garden?.publishedAt) return null;
  let organization = null;
  if (garden.organization?.publishedAt) organization = { title: garden.organization.title ?? null };
  return {
    documentId: garden.documentId,
    slug: garden.slug ?? null,
    title: garden.title ?? null,
    hero_image: publicMedia(garden.hero_image),
    organization,
  };
}

function publicEventTime(event) {
  return { id: event.id, documentId: event.documentId, startDatetime: event.startDatetime ?? null };
}

const gardenPopulate = {
  fields: ['documentId', 'slug', 'title', 'publishedAt'],
  populate: {
    hero_image: { fields: mediaFields },
    organization: { fields: ['title', 'publishedAt'] },
  },
};

module.exports = ({ strapi }) => ({
  visibleFilters: visibleEventFilters,
  gardenRef: publicGardenRef,
  eventTime: publicEventTime,
  gardenPopulate,

  async list(pagination) {
    const filters = visibleEventFilters(new Date());
    const [events, total] = await Promise.all([
      strapi.documents(UID).findMany({
        status: 'published', filters,
        fields: ['title', 'blurb', 'startDatetime', 'location_name'],
        populate: { hero_image: { fields: mediaFields }, garden: gardenPopulate },
        sort: ['startDatetime:desc', 'documentId:asc'],
        start: pagination.start, limit: pagination.limit,
      }),
      strapi.documents(UID).count({ status: 'published', filters }),
    ]);
    const data = events.map(event => {
      const garden = publicGardenRef(event.garden);
      return {
        id: event.id,
        documentId: event.documentId,
        title: event.title ?? null,
        blurb: event.blurb ?? null,
        startDatetime: event.startDatetime ?? null,
        canceled: false,
        location_name: event.location_name ?? null,
        hero_image: publicMedia(event.hero_image) || garden?.hero_image || null,
        garden,
      };
    });
    return publicPage(data, total, pagination);
  },

  async nextForGarden(documentId, now) {
    const rows = await strapi.documents(UID).findMany({
      status: 'published',
      filters: { $and: [visibleEventFilters(now), { garden: { documentId }, startDatetime: { $gte: now.toISOString() } }] },
      fields: ['startDatetime'], sort: ['startDatetime:asc', 'documentId:asc'], limit: 1,
    });
    if (!rows.length) return null;
    return publicEventTime(rows[0]);
  },

  async nextForProject(documentId, now) {
    const rows = await strapi.documents(UID).findMany({
      status: 'published',
      filters: { $and: [visibleEventFilters(now), { projects: { documentId }, startDatetime: { $gte: now.toISOString() } }] },
      fields: ['startDatetime'], sort: ['startDatetime:asc', 'documentId:asc'], limit: 1,
    });
    return rows.map(publicEventTime);
  },
});
