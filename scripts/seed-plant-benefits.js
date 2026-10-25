/**
 * Benefits for the seed plants, and beds for the two sample gardens near 94609
 * so their islands have something growing and Explore can add the benefits up.
 *
 * Idempotent: plants get their benefit list replaced; the sample gardens get
 * their plots replaced. Other gardens are left alone.
 *
 * Usage, from the backend folder: node scripts/seed-plant-benefits.js
 */
process.env.CRON_ENABLED = 'false';

const { createStrapi } = require('@strapi/strapi');

// Plant slug → [title, potency]. Potency: minimal | mild | moderate | strong | profound.
const BENEFITS = {
  tomato: [['Food', 'strong'], ['Pollinators', 'mild']],
  lavender: [['Pollinators', 'profound'], ['Fragrance & calm', 'strong'], ['Drought tolerant', 'strong']],
  apple: [['Food', 'profound'], ['Pollinators', 'strong'], ['Shade', 'moderate']],
  lemon: [['Food', 'strong'], ['Fragrance & calm', 'mild']],
  mint: [['Medicinal', 'moderate'], ['Pollinators', 'moderate'], ['Ground cover', 'strong']],
  'yerba-santa': [['Medicinal', 'strong'], ['Native habitat', 'profound'], ['Drought tolerant', 'strong']],
  'buena-nettle': [['Medicinal', 'strong'], ['Native habitat', 'strong'], ['Food', 'mild']],
  'lemon-balm': [['Medicinal', 'moderate'], ['Pollinators', 'strong'], ['Fragrance & calm', 'strong']],
  'passion-fruit': [['Food', 'strong'], ['Pollinators', 'strong'], ['Shade', 'moderate']],
  broccoli: [['Food', 'strong']],
  cauliflower: [['Food', 'strong']],
  collard: [['Food', 'strong'], ['Ground cover', 'mild']],
  kale: [['Food', 'profound']],
};

// Garden slug → beds, in layout order.
const PLOTS = {
  'temescal-creek-garden': [
    ['Bed 1', 'tomato'], ['Bed 2', 'kale'], ['Border', 'lavender'], ['Creek edge', 'mint'], ['Tree', 'lemon'], ['Orchard', 'apple'],
  ],
  'shafter-avenue-plot': [
    ['Row A', 'tomato'], ['Row B', 'tomato'], ['Row C', 'kale'], ['Corner', 'collard'],
  ],
};

async function run() {
  const strapi = createStrapi();
  await strapi.load();
  try {
    const plants = await strapi.db.query('api::plant.plant').findMany({ select: ['id', 'documentId', 'slug', 'title'] });
    const bySlug = new Map();
    for (const p of plants) if (p.slug && !bySlug.has(p.slug)) bySlug.set(p.slug, p);

    console.log('Setting plant benefits...');
    for (const [slug, list] of Object.entries(BENEFITS)) {
      const plant = bySlug.get(slug);
      if (!plant) { console.log(`  (no plant with slug ${slug}, skipped)`); continue; }
      const Benefits = list.map(([title, potency]) => ({ title, potency }));
      await strapi.documents('api::plant.plant').update({ documentId: plant.documentId, data: { Benefits } });
      try { await strapi.documents('api::plant.plant').publish({ documentId: plant.documentId }); } catch (e) { /* plants may not use draft/publish */ }
      console.log(`  ${plant.title}: ${list.map(([t]) => t).join(', ')}`);
    }

    console.log('Laying out sample garden beds...');
    for (const [gardenSlug, beds] of Object.entries(PLOTS)) {
      const garden = await strapi.db.query('api::garden.garden').findOne({ where: { slug: gardenSlug } });
      if (!garden) { console.log(`  (no garden with slug ${gardenSlug}; run seed-sample-health-gardens first)`); continue; }
      const items = beds.map(([label, slug]) => ({ label, plant: bySlug.get(slug)?.documentId || null }));
      await strapi.service('api::garden.plots').replaceForGarden(garden, items);
      console.log(`  ${garden.title}: ${beds.map(([, s]) => bySlug.get(s)?.title || s).join(', ')}`);
    }
    console.log('Done.');
  } catch (err) {
    console.error('Plant benefits seed failed:', err);
    process.exitCode = 1;
  } finally {
    await strapi.destroy().catch(() => null);
  }
}

run();
