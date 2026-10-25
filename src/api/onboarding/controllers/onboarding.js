'use strict';

const { normalizePhoneNumber } = require('../../../utils/phone');
const { cleanProfile, benefitNotes } = require('../../../utils/volunteer-profile');

const USER = 'plugin::users-permissions.user';
const PROFILE_KEYS = ['id', 'firstName', 'lastName', 'email', 'phoneNumber', 'status', 'linkedinUrl', 'employer', 'jobTitle', 'skills', 'availability', 'frequency', 'volunteerBenefits', 'goals', 'smsConsent', 'emailConsent', 'onboardingCompletedAt'];

// A light per-address limit on public sign-ups.
const recent = new Map();
const LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;
function allowed(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  const ok = hits.length < LIMIT;
  if (ok) hits.push(now);
  recent.set(ip, hits);
  return ok;
}

const pick = (user) => Object.fromEntries(PROFILE_KEYS.map((key) => [key, user[key] ?? null]));

async function publishedGardens() {
  return strapi.db.query('api::garden.garden').findMany({ where: { publishedAt: { $notNull: true } }, select: ['id', 'documentId', 'title', 'slug'], orderBy: { title: 'asc' } });
}

async function publishedInterests() {
  return strapi.db.query('api::interest.interest').findMany({ where: { publishedAt: { $notNull: true } }, select: ['id', 'documentId', 'tag'], populate: { gardens: { select: ['documentId'] } }, orderBy: { tag: 'asc' } });
}

async function currentUser(ctx) {
  try {
    const payload = await strapi.plugin('users-permissions').service('jwt').getToken(ctx);
    if (!payload?.id) return null;
    return strapi.db.query(USER).findOne({ where: { id: payload.id }, populate: { u_g_interests: { populate: { interest: { select: ['tag'] } } } } });
  } catch {
    return null;
  }
}

async function linkInterests(userId, garden, interestDocumentIds) {
  if (!garden || !Array.isArray(interestDocumentIds) || !interestDocumentIds.length) return [];
  const interests = (await publishedInterests()).filter((interest) => interestDocumentIds.includes(interest.documentId)).slice(0, 12);
  for (const interest of interests) {
    const existing = await strapi.db.query('api::user-garden-interest.user-garden-interest').findOne({ where: { user: userId, garden: garden.id, interest: interest.id } });
    if (!existing) await strapi.db.query('api::user-garden-interest.user-garden-interest').create({ data: { user: userId, garden: garden.id, interest: interest.id, publishedAt: new Date() } });
  }
  return interests.map((interest) => interest.tag);
}

module.exports = {
  // GET /onboarding/options: the gardens someone can join and the interests each one offers.
  async options(ctx) {
    const [gardens, interests] = await Promise.all([publishedGardens(), publishedInterests()]);
    ctx.body = {
      gardens: gardens.map((garden) => ({
        documentId: garden.documentId,
        title: garden.title,
        slug: garden.slug,
        interests: interests.filter((interest) => (interest.gardens || []).some((item) => item.documentId === garden.documentId)).map((interest) => ({ documentId: interest.documentId, tag: interest.tag })),
      })),
    };
  },

  // POST /onboarding/join: a new volunteer's full profile. Existing numbers are never overwritten.
  async join(ctx) {
    if (!allowed(ctx.request.ip)) return ctx.tooManyRequests('Too many sign-ups from this connection. Please try again later.');
    const body = ctx.request.body || {};
    const phone = normalizePhoneNumber(body.phoneNumber || '');
    if (!phone.valid) return ctx.badRequest(phone.message);
    const { data, error } = cleanProfile(body);
    if (error) return ctx.badRequest(error);
    if (!data.firstName) return ctx.badRequest('Please tell us your first name.');
    if (!data.email) return ctx.badRequest('Please add an email address.');
    if (body.smsConsent !== true) return ctx.badRequest('Please agree to texts so the garden can reach you about volunteer days.');

    const gardens = await publishedGardens();
    const garden = gardens.find((item) => item.documentId === body.gardenId);
    if (!garden) return ctx.badRequest('Choose a garden to join.');

    const existing = await strapi.db.query(USER).findOne({ where: { phoneNumber: phone.phoneNumber }, select: ['id'] });
    if (existing) return ctx.conflict('This number is already registered. Sign in to update your profile, or text the garden to rejoin.');

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' }, select: ['id'] });
    const now = new Date().toISOString();
    const user = await strapi.db.query(USER).create({
      data: {
        ...data,
        phoneNumber: phone.phoneNumber,
        username: phone.phoneNumber,
        provider: 'local',
        confirmed: false,
        blocked: false,
        status: 'INTERESTED',
        role: role?.id,
        gardens: [garden.id],
        activeGarden: garden.id,
        smsConsent: true,
        smsConsentAt: now,
        onboardingCompletedAt: now,
      },
    });
    const interests = await linkInterests(user.id, garden, body.interestIds);
    ctx.status = 201;
    ctx.body = { volunteer: { id: user.id, firstName: user.firstName, garden: garden.title, interests }, notes: benefitNotes(data.volunteerBenefits, garden.title) };
  },

  // GET /onboarding/me: the signed-in volunteer's profile.
  async me(ctx) {
    const user = await currentUser(ctx);
    if (!user) return ctx.unauthorized('Sign in to see your profile.');
    ctx.body = { profile: { ...pick(user), interests: (user.u_g_interests || []).map((item) => item.interest?.tag).filter(Boolean) }, notes: benefitNotes(user.volunteerBenefits) };
  },

  // PUT /onboarding/me: the signed-in volunteer updates their own profile.
  async updateMe(ctx) {
    const user = await currentUser(ctx);
    if (!user) return ctx.unauthorized('Sign in to update your profile.');
    const { data, error } = cleanProfile({ ...pick(user), ...(ctx.request.body || {}), benefits: ctx.request.body?.benefits ?? user.volunteerBenefits });
    if (error) return ctx.badRequest(error);
    if (!data.firstName) return ctx.badRequest('Please keep a first name on your profile.');
    if (!data.email) delete data.email;
    const updated = await strapi.db.query(USER).update({ where: { id: user.id }, data: { ...data, onboardingCompletedAt: user.onboardingCompletedAt || new Date().toISOString() } });
    ctx.body = { profile: pick(updated), notes: benefitNotes(updated.volunteerBenefits) };
  },
};
