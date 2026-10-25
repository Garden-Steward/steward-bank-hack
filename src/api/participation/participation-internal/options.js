'use strict';

const groups = {
  offeredSkillIds: [
    ['plant_care', 'Plant care'], ['building_repairs', 'Building & repairs'], ['cooking', 'Cooking'],
    ['welcoming', 'Welcoming people'], ['design_signs', 'Design & signs'],
  ],
  learningSkillIds: [
    ['growing_food', 'Growing food'], ['native_plants', 'Native plants'], ['seed_starting', 'Seed starting'],
    ['garden_design', 'Garden design'], ['building_repairs', 'Building & repairs'],
  ],
  availabilityIds: [
    ['weekday_mornings', 'Weekday mornings'], ['weekday_evenings', 'Weekday evenings'],
    ['weekend_mornings', 'Weekend mornings'], ['weekend_afternoons', 'Weekend afternoons'],
  ],
  taskPreferenceIds: [
    ['seated', 'Seated tasks'], ['light_garden', 'Light garden work'], ['materials', 'Moving materials'],
    ['welcoming_food', 'Welcoming & food'], ['decide_on_day', 'Decide on the day'],
  ],
  experience: [['starting', 'Starting out'], ['some', 'Some experience'], ['can_share', 'Happy to share what I know']],
};

module.exports = ({ strapi }) => ({
  async read() {
    const gardens = await strapi.documents('api::garden.garden').findMany({ status: 'published', fields: ['title'], sort: ['title:asc', 'documentId:asc'] });
    const interests = await strapi.documents('api::interest.interest').findMany({ status: 'published', fields: ['tag'], sort: ['tag:asc', 'documentId:asc'] });
    const preferences = {
      gardenDocumentIds: gardens.map(row => ({ id: row.documentId, label: row.title })),
      interestIds: interests.map(row => ({ id: row.documentId, label: row.tag })),
    };
    for (const [name, values] of Object.entries(groups)) preferences[name] = values.map(([id, label]) => ({ id, label }));
    return {
      version: 'garden-life-v1', required: ['preferredNameRaw', 'emailRaw', 'phoneRaw'], preferences,
      newsletter: strapi.service('api::newsletter.newsletter').disclosure,
    };
  },
});
