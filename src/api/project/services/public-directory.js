'use strict';

const { publicMedia, mediaFields } = require('../../../utils/public-media');
const { publicPage } = require('../../../utils/public-input');
const UID = 'api::project.project';

module.exports = ({ strapi }) => ({
  async list(pagination) {
    const now = new Date();
    const filters = {
      review_status: { $in: ['APPROVED', 'COMPLETED'] },
      $or: [{ garden: { $null: true } }, { garden: { publishedAt: { $notNull: true } } }],
    };
    const [projects, total] = await Promise.all([
      strapi.documents(UID).findMany({
        filters,
        fields: ['slug', 'title', 'short_description', 'date_start', 'date_end', 'review_status', 'category'],
        populate: {
          hero_image: { fields: mediaFields }, featured_gallery: { fields: mediaFields },
          garden: { fields: ['documentId'] }, interested: { fields: ['id'] },
        },
        sort: ['createdAt:desc', 'documentId:asc'], start: pagination.start, limit: pagination.limit,
      }),
      strapi.documents(UID).count({ filters }),
    ]);
    const eventFeed = strapi.service('api::volunteer-day.public-feed');
    const rows = await Promise.all(projects.map(async project => {
      let garden = null;
      if (project.garden) {
        const published = await strapi.documents('api::garden.garden').findOne({
          documentId: project.garden.documentId, status: 'published',
          ...eventFeed.gardenPopulate,
        });
        garden = eventFeed.gardenRef(published);
        if (!garden) return null;
      }
      return {
        id: project.id,
        documentId: project.documentId,
        slug: project.slug ?? null,
        title: project.title ?? null,
        short_description: project.short_description ?? null,
        date_start: project.date_start ?? null,
        date_end: project.date_end ?? null,
        review_status: project.review_status,
        category: project.category ?? null,
        hero_image: publicMedia(project.hero_image),
        featured_gallery: (project.featured_gallery || []).map(publicMedia).filter(Boolean),
        garden,
        interested: (project.interested || []).map(user => ({ id: user.id })),
        related_events: await eventFeed.nextForProject(project.documentId, now),
      };
    }));
    return publicPage(rows.filter(Boolean), total, pagination);
  },
});
