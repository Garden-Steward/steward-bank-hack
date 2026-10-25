/**
 * Garden plots (/api/gardens/:slug/plots): the beds on a garden's Explore
 * island. Anyone can read them; only a manager of THAT garden (or an
 * administrator) can lay them out.
 */
const request = require('supertest');
const { createUser } = require('../user/factory');

describe('Garden plots (/api/gardens/:slug/plots)', function () {
  const ACTION = 'api::garden.garden.replacePlots';

  let tomato;
  let basil;
  let ownManagerJwt;
  let otherManagerJwt;

  const api = () => request(strapi.server.httpServer);
  const get = (slug) => api().get(`/api/gardens/${slug}/plots`);
  const put = (slug, jwt, body) => {
    const r = api().put(`/api/gardens/${slug}/plots`);
    if (jwt) r.set('Authorization', `Bearer ${jwt}`);
    return r.send(body);
  };

  beforeAll(async () => {
    const authRole = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
    const perms = strapi.db.query('plugin::users-permissions.permission');
    if (!(await perms.findOne({ where: { action: ACTION, role: { id: authRole.id } } }))) {
      await perms.create({ data: { action: ACTION, role: authRole.id } });
    }

    const ownManager = await createUser({ username: 'plots-own', email: 'plots-own@example.com' });
    const otherManager = await createUser({ username: 'plots-other', email: 'plots-other@example.com' });

    await strapi.documents('api::garden.garden').create({
      data: { title: 'Plots One', slug: 'plots-one', sms_slug: 'plotsone', managers: [ownManager.documentId] },
      status: 'published',
    });
    await strapi.documents('api::garden.garden').create({
      data: { title: 'Plots Two', slug: 'plots-two', sms_slug: 'plotstwo', managers: [otherManager.documentId] },
      status: 'published',
    });
    tomato = await strapi.documents('api::plant.plant').create({
      data: { title: 'Plots Tomato', latin: 'Solanum lycopersicum', type: 'annual', slug: 'plots-tomato' },
      status: 'published',
    });
    basil = await strapi.documents('api::plant.plant').create({
      data: { title: 'Plots Basil', type: 'herb', slug: 'plots-basil' },
      status: 'published',
    });

    const jwt = strapi.plugins['users-permissions'].services.jwt;
    ownManagerJwt = jwt.issue({ id: ownManager.id });
    otherManagerJwt = jwt.issue({ id: otherManager.id });
  });

  it('is empty and unsaved before anyone lays out plots, and public to read', async () => {
    const res = await get('plots-one').expect(200);
    expect(res.body.data.plots).toEqual([]);
    expect(res.body.data.meta.saved).toBe(false);
  });

  it('a manager of THIS garden can lay out plots, in order, with the same plant twice and an empty bed', async () => {
    const res = await put('plots-one', ownManagerJwt, {
      data: {
        plots: [
          { label: 'Bed 1', plant: tomato.documentId },
          { label: '  Herb   corner ', plant: basil.documentId },
          { label: 'Bed 3', plant: tomato.documentId },
          { label: null, plant: null },
        ],
      },
    });
    expect(res.status).toBe(200);
    const { plots, meta } = res.body.data;
    expect(meta.saved).toBe(true);
    expect(plots.map((p) => p.label)).toEqual(['Bed 1', 'Herb corner', 'Bed 3', null]);
    expect(plots.map((p) => p.plant?.title ?? null)).toEqual(['Plots Tomato', 'Plots Basil', 'Plots Tomato', null]);
    expect(plots[0].plant.type).toBe('annual');
    expect(plots[0].plant.latin).toBe('Solanum lycopersicum');

    // Signed out, the same layout comes back.
    const pub = await get('plots-one').expect(200);
    expect(pub.body.data.plots.map((p) => p.plant?.title ?? null)).toEqual(['Plots Tomato', 'Plots Basil', 'Plots Tomato', null]);
  });

  it('saving again replaces the layout rather than adding to it', async () => {
    const res = await put('plots-one', ownManagerJwt, { data: { plots: [{ label: 'Only bed', plant: basil.documentId }] } });
    expect(res.status).toBe(200);
    expect(res.body.data.plots).toHaveLength(1);
    expect(res.body.data.plots[0].plant.title).toBe('Plots Basil');
  });

  it('a manager of a DIFFERENT garden is refused, and the plots are untouched', async () => {
    const before = await get('plots-one');
    const res = await put('plots-one', otherManagerJwt, { data: { plots: [] } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only managers of this garden can edit its plots');
    const after = await get('plots-one');
    expect(after.body.data.plots).toEqual(before.body.data.plots);
  });

  it('an anonymous write is refused', async () => {
    const res = await put('plots-one', null, { data: { plots: [] } });
    expect([401, 403]).toContain(res.status);
  });

  it('rejects an unknown plant without echoing it back', async () => {
    const res = await put('plots-one', ownManagerJwt, { data: { plots: [{ plant: 'doesnotexist123' }] } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Plot 0: plant not found');
  });

  it('rejects a bad payload', async () => {
    let res = await put('plots-one', ownManagerJwt, { data: { plots: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('plots must be an array');

    res = await put('plots-one', ownManagerJwt, { data: { plots: [{ label: 'x'.repeat(61), plant: null }] } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Plot 0: label must be 60 characters or fewer');

    res = await put('plots-one', ownManagerJwt, {
      data: { plots: Array.from({ length: 65 }, () => ({ plant: null })) },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('plots may contain at most 64 items');
  });

  it('each garden keeps its own plots', async () => {
    await put('plots-two', otherManagerJwt, { data: { plots: [{ label: 'Two', plant: tomato.documentId }] } }).expect(200);
    const one = await get('plots-one');
    const two = await get('plots-two');
    expect(one.body.data.plots.map((p) => p.label)).toEqual(['Only bed']);
    expect(two.body.data.plots.map((p) => p.label)).toEqual(['Two']);
  });

  it('404s an unknown garden', async () => {
    await get('no-such-garden').expect(404);
  });
});
