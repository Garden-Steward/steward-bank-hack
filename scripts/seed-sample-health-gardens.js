/**
 * Two sample gardens near 94609 (Temescal, Oakland) to show garden health on
 * Explore: one thriving, one short of hands. Each gets managers, a daily
 * repeating task, a fortnight of that task's daily copies (finished or not),
 * an open task for today, and a workday with a few people going.
 *
 * Idempotent: an existing sample garden (by slug) is removed and rebuilt.
 *
 * Usage, from the backend folder: node scripts/seed-sample-health-gardens.js
 */
process.env.CRON_ENABLED = 'false';

const { createStrapi } = require('@strapi/strapi');

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysAgo, hour = 9) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return new Date(d.getTime() - daysAgo * DAY_MS);
};

const SAMPLES = [
  {
    garden: {
      title: 'Temescal Creek Garden',
      slug: 'temescal-creek-garden',
      sms_slug: 'temescal',
      blurb: 'Raised beds along the creek path, watered every morning by a rota of neighbours.',
      latitude: 37.8372,
      longitude: -122.2618,
      welcome_text: 'Welcome to Temescal Creek Garden! Morning watering is at 8.',
    },
    repeat: { title: 'Water the creek beds', type: 'Water', overview: 'Deep soak every raised bed. Hose is on the shed wall.', max_volunteers: 2 },
    // Fourteen days, oldest first: every day done, two people each day.
    days: Array.from({ length: 14 }, (_, i) => ({ daysAgo: 13 - i, done: true })),
    open: [
      { title: 'Harvest the figs', type: 'Harvest', overview: 'The two fig trees by the gate are ready. Baskets in the shed.', max_volunteers: 3 },
    ],
    event: { title: 'Saturday Creek Clean-up', going: 4 },
  },
  {
    garden: {
      title: 'Shafter Avenue Plot',
      slug: 'shafter-avenue-plot',
      sms_slug: 'shafter',
      blurb: 'A corner lot of tomatoes and kale that could use a few more hands.',
      latitude: 37.8418,
      longitude: -122.2574,
      welcome_text: 'Welcome to the Shafter Avenue Plot!',
    },
    repeat: { title: 'Water the tomato rows', type: 'Water', overview: 'Water along the drip line, about 15 minutes.', max_volunteers: 2 },
    // A good first week, then it fell apart: the last five days nobody watered.
    days: Array.from({ length: 14 }, (_, i) => ({ daysAgo: 13 - i, done: i < 9 })),
    open: [
      { title: 'Weed the kale bed', type: 'Weeding', overview: 'Bindweed is taking the kale. Hand fork and kneeler in the box.', max_volunteers: 2 },
      { title: 'Fix the gate latch', type: 'General', overview: 'The latch sticks; needs a screwdriver and ten minutes.', max_volunteers: 1 },
    ],
    event: { title: 'Sunday Rescue Workday', going: 1 },
  },
];

const nextSaturday = () => {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(10, 0, 0, 0);
  return d;
};

async function removeExisting(strapi, slug) {
  const gardens = await strapi.db.query('api::garden.garden').findMany({ where: { slug } });
  for (const g of gardens) {
    await strapi.db.query('api::garden-task.garden-task').deleteMany({ where: { garden: g.id } });
    await strapi.db.query('api::recurring-task.recurring-task').deleteMany({ where: { garden: g.id } });
    await strapi.db.query('api::volunteer-day.volunteer-day').deleteMany({ where: { garden: g.id } });
  }
  if (gardens.length) await strapi.db.query('api::garden.garden').deleteMany({ where: { slug } });
}

/** Backdate every row of a document (Strapi 5 keeps a draft and a published row). */
const backdate = (strapi, uid, documentId, when) =>
  strapi.db.query(uid).updateMany({ where: { documentId }, data: { createdAt: when, updatedAt: when } });

async function seedSample(strapi, sample, people) {
  const managers = people.slice(0, 3).map((u) => u.id);
  const volunteers = people.map((u) => u.id);
  const organization = (await strapi.db.query('api::organization.organization').findOne()) || null;

  await removeExisting(strapi, sample.garden.slug);

  const garden = await strapi.entityService.create('api::garden.garden', {
    data: {
      ...sample.garden,
      organization: organization?.id ?? null,
      managers,
      volunteers,
      publishedAt: new Date(),
    },
  });

  const repeat = await strapi.entityService.create('api::recurring-task.recurring-task', {
    data: {
      ...sample.repeat,
      garden: garden.id,
      scheduler_type: 'No Schedule',
      repeat_frequency: 'daily',
      complete_once: true,
      publishedAt: new Date(),
    },
  });

  for (const day of sample.days) {
    const when = at(day.daysAgo, 8);
    const who = day.done ? volunteers.slice(day.daysAgo % 2, (day.daysAgo % 2) + 2) : [];
    const task = await strapi.entityService.create('api::garden-task.garden-task', {
      data: {
        title: sample.repeat.title,
        type: sample.repeat.type,
        overview: sample.repeat.overview,
        max_volunteers: sample.repeat.max_volunteers,
        complete_once: true,
        garden: garden.id,
        recurring_task: repeat.id,
        volunteers: who,
        task_status: day.done ? 'FINISHED' : 'INITIALIZED',
        started_at: day.done ? when : null,
        completed_at: day.done ? new Date(when.getTime() + 45 * 60 * 1000) : null,
        publishedAt: when,
      },
    });
    await backdate(strapi, 'api::garden-task.garden-task', task.documentId, when);
  }

  for (const open of sample.open) {
    await strapi.entityService.create('api::garden-task.garden-task', {
      data: { ...open, complete_once: true, garden: garden.id, task_status: 'INITIALIZED', publishedAt: new Date() },
    });
  }

  await strapi.entityService.create('api::volunteer-day.volunteer-day', {
    data: {
      title: sample.event.title,
      blurb: `Come lend a hand at ${sample.garden.title}.`,
      garden: garden.id,
      startDatetime: nextSaturday(),
      endText: '12:00 PM',
      accessibility: 'Public',
      confirmed: volunteers.slice(0, sample.event.going),
      publishedAt: new Date(),
    },
  });

  console.log(`  ${sample.garden.title}: ${sample.days.filter((d) => d.done).length}/${sample.days.length} days done, ${sample.open.length} open task(s), workday with ${sample.event.going} going`);
}

async function run() {
  const strapi = createStrapi();
  await strapi.load();
  try {
    // Managers and volunteers: the people already looking after the seed gardens, else anyone.
    const anchor = await strapi.db.query('api::garden.garden').findOne({ where: { slug: 'downtown-garden' }, populate: ['managers'] });
    let people = anchor?.managers || [];
    if (!people.length) people = await strapi.db.query('plugin::users-permissions.user').findMany({ limit: 6 });
    if (!people.length) throw new Error('No users to make managers. Run the main seed first.');

    console.log('Seeding two sample gardens near 94609...');
    for (const sample of SAMPLES) await seedSample(strapi, sample, people);
    console.log('Done.');
  } catch (err) {
    console.error('Sample garden seed failed:', err);
    process.exitCode = 1;
  } finally {
    await strapi.destroy();
  }
}

run();
