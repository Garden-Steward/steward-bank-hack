'use strict';

const { publicMedia, mediaFields } = require('../../../utils/public-media');
const { publicPage, slugFilters } = require('../../../utils/public-input');
const UID = 'api::garden.garden';

function approximateLocation(garden) {
  const lat = garden.latitude;
  const lng = garden.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { latitude: null, longitude: null };
  }
  const latitude = Math.floor(lat / 0.01) * 0.01 + 0.005;
  const longitude = Math.floor(lng / 0.01) * 0.01 + 0.005;
  if (latitude > 90 || longitude > 180) return { latitude: null, longitude: null };
  return { latitude, longitude };
}

module.exports = ({ strapi }) => ({
  async list(pagination) {
    const now = new Date();
    const filters = slugFilters(strapi, UID);
    const [gardens, total] = await Promise.all([
      strapi.documents(UID).findMany({
        status: 'published', filters,
        fields: ['slug', 'title', 'blurb', 'latitude', 'longitude'],
        populate: { hero_image: { fields: mediaFields }, volunteers: { fields: ['id'] } },
        sort: ['title:asc', 'documentId:asc'], start: pagination.start, limit: pagination.limit,
      }),
      strapi.documents(UID).count({ status: 'published', filters }),
    ]);
    const dateThreshold = new Date(Math.ceil(now.getTime() / 86400000) * 86400000).toISOString().slice(0, 10);
    const data = await Promise.all(gardens.map(async garden => {
      const [activeProjectCount, nextWorkday] = await Promise.all([
        strapi.documents('api::project.project').count({ filters: {
          garden: { documentId: garden.documentId },
          review_status: { $in: ['APPROVED', 'COMPLETED'] },
          $or: [{ date_end: { $null: true } }, { date_end: { $gte: dateThreshold } }],
        } }),
        strapi.service('api::volunteer-day.public-feed').nextForGarden(garden.documentId, now),
      ]);
      return {
        documentId: garden.documentId,
        slug: garden.slug,
        title: garden.title ?? null,
        blurb: garden.blurb ?? null,
        hero_image: publicMedia(garden.hero_image),
        volunteers: (garden.volunteers || []).map(user => ({ id: user.id })),
        activeProjectCount,
        nextWorkday,
        ...approximateLocation(garden),
        location_approximate: true,
      };
    }));
    return publicPage(data, total, pagination);
  },
});
