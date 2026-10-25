'use strict';

// Dropping off a task, the reserve list, and finishing a task from the page.
//
// A task has `max_volunteers` spots. When it's full, people join `reserves`
// (in join order). When a volunteer drops off, or a manager raises the spot
// count, the first reserve is texted an offer: reply YES within OFFER_HOURS to
// take the spot. NO, or silence past the window, passes the offer to the next
// reserve. Nothing here ever removes a volunteer the user didn't remove.

const TASK = 'api::garden-task.garden-task';
const OFFER_HOURS = 2;
const OFFER_MS = OFFER_HOURS * 60 * 60 * 1000;

const ids = (list) => (Array.isArray(list) ? list.map((u) => (typeof u === 'object' ? u.id : u)) : []);
const spotsOf = (task) => Math.max(0, (task.max_volunteers || 1) - ids(task.volunteers).length);

const load = (id) => strapi.db.query(TASK).findOne({
  where: { id },
  populate: ['garden', 'volunteers', 'reserves', 'recurring_task'],
});

const text = (user, task, body, type, meta_data, source) => strapi.service('api::sms.sms').handleSms({
  user, task, body, type, meta_data, garden: task.garden, category: 'transactional', source,
});

const reserve = {};

reserve.spotsOf = spotsOf;
reserve.OFFER_HOURS = OFFER_HOURS;

/** Take `user` off the task's volunteers and remember when. Then offer the spot to the reserve list. */
reserve.leaveTask = async (taskId, user) => {
  const task = await load(taskId);
  if (!task) throw new Error('Task not found');
  const was = ids(task.volunteers);
  if (!was.includes(user.id)) return { task, left: false };
  const dropped = Array.isArray(task.dropped) ? task.dropped : [];
  await strapi.db.query(TASK).update({
    where: { id: task.id },
    data: {
      volunteers: was.filter((id) => id !== user.id),
      dropped: [...dropped, { user: user.id, at: new Date().toISOString() }],
    },
  });
  await reserve.offerNext(task.id);
  return { task: await load(task.id), left: true };
};

/** Add `user` to the end of the reserve list. If a spot is already open, offer it right away. */
reserve.join = async (taskId, user) => {
  const task = await load(taskId);
  if (!task) throw new Error('Task not found');
  if (ids(task.volunteers).includes(user.id)) return { task, joined: false, reason: 'already a volunteer' };
  const current = ids(task.reserves);
  const already = current.includes(user.id);
  if (!already) {
    await strapi.db.query(TASK).update({ where: { id: task.id }, data: { reserves: [...current, user.id] } });
  }
  if (spotsOf(task) > 0) await reserve.offerNext(task.id);
  return { task: await load(task.id), joined: !already, position: already ? current.indexOf(user.id) + 1 : current.length + 1 };
};

reserve.leave = async (taskId, user) => {
  const task = await load(taskId);
  if (!task) throw new Error('Task not found');
  const current = ids(task.reserves);
  const data = { reserves: current.filter((id) => id !== user.id) };
  const hadOffer = task.reserve_offer_user === user.id;
  if (hadOffer) Object.assign(data, { reserve_offer_user: null, reserve_offer_at: null });
  await strapi.db.query(TASK).update({ where: { id: task.id }, data });
  if (hadOffer) await reserve.offerNext(task.id);
  return { task: await load(task.id) };
};

/**
 * Text the first reserve who isn't already holding an offer. No-op while an
 * offer is pending, when the task is full, or when nobody's waiting.
 */
reserve.offerNext = async (taskId) => {
  const task = await load(taskId);
  if (!task || spotsOf(task) === 0) return null;
  if (task.reserve_offer_user && task.reserve_offer_at && Date.now() - Date.parse(task.reserve_offer_at) < OFFER_MS) return null;
  const next = (task.reserves || []).find((u) => u.id !== task.reserve_offer_user) || task.reserves?.[0];
  if (!next) {
    if (task.reserve_offer_user) await strapi.db.query(TASK).update({ where: { id: task.id }, data: { reserve_offer_user: null, reserve_offer_at: null } });
    return null;
  }
  await strapi.db.query(TASK).update({ where: { id: task.id }, data: { reserve_offer_user: next.id, reserve_offer_at: new Date() } });
  await text(
    next, task,
    `A spot just opened on "${task.title}" at ${task.garden?.title || 'the garden'}. Reply YES within ${OFFER_HOURS} hours to take it, or NO to pass. If we don't hear back it goes to the next person.`,
    'question', { reserveTaskId: task.id }, 'task.reserve-offer',
  );
  return next;
};

/** YES from the person holding the offer: they become a volunteer. */
reserve.accept = async (user, taskId) => {
  const task = await load(taskId);
  if (!task) return { body: "That task isn't around any more. Sorry!", type: 'reply' };
  if (task.reserve_offer_user !== user.id) return { body: "That spot has already gone to someone else. You're still on the list for next time.", type: 'reply', task };
  if (Date.parse(task.reserve_offer_at) + OFFER_MS < Date.now()) {
    await reserve.offerNext(task.id);
    return { body: `Sorry, the ${OFFER_HOURS}-hour window passed and the spot moved on. You're still on the reserve list.`, type: 'reply', task };
  }
  if (spotsOf(task) === 0) {
    await strapi.db.query(TASK).update({ where: { id: task.id }, data: { reserve_offer_user: null, reserve_offer_at: null } });
    return { body: "Looks like that spot filled up in the meantime. You're still on the reserve list.", type: 'reply', task };
  }
  const starting = ['INITIALIZED', 'PENDING', 'INTERESTED'].includes(task.task_status);
  await strapi.db.query(TASK).update({
    where: { id: task.id },
    data: {
      volunteers: [...ids(task.volunteers), user.id],
      reserves: ids(task.reserves).filter((id) => id !== user.id),
      reserve_offer_user: null,
      reserve_offer_at: null,
      ...(starting ? { task_status: 'STARTED', started_at: new Date() } : {}),
      ...(task.task_status === 'INITIALIZED' ? { publishedAt: new Date() } : {}),
    },
  });
  const updated = await load(task.id);
  return { body: `You're on "${task.title}". Thanks for stepping in! Text DONE when it's finished.`, type: 'complete', task: updated };
};

/** NO from the person holding the offer: they leave the list and the next reserve is texted. */
reserve.decline = async (user, taskId) => {
  const task = await load(taskId);
  if (!task || task.reserve_offer_user !== user.id) return { body: 'No problem.', type: 'reply', task };
  await strapi.db.query(TASK).update({
    where: { id: task.id },
    data: { reserves: ids(task.reserves).filter((id) => id !== user.id), reserve_offer_user: null, reserve_offer_at: null },
  });
  await reserve.offerNext(task.id);
  return { body: `No problem, we've passed "${task.title}" along.`, type: 'complete', task };
};

/** Cron: offers nobody answered within the window move to the next reserve. The quiet one goes to the back of the list. */
reserve.expireOffers = async () => {
  const stale = await strapi.db.query(TASK).findMany({
    where: { reserve_offer_user: { $notNull: true }, reserve_offer_at: { $lt: new Date(Date.now() - OFFER_MS) } },
    populate: ['reserves'],
  });
  for (const task of stale) {
    const quiet = task.reserve_offer_user;
    const rest = ids(task.reserves).filter((id) => id !== quiet);
    await strapi.db.query(TASK).update({
      where: { id: task.id },
      data: { reserves: rest.length ? [...rest, quiet] : [], reserve_offer_user: null, reserve_offer_at: null },
    });
    if (rest.length) await reserve.offerNext(task.id);
  }
  return stale.length;
};

/** A volunteer on the task finishes it from the page. Same bookkeeping as texting DONE. */
reserve.finish = async (taskId, user) => {
  const task = await load(taskId);
  if (!task) throw new Error('Task not found');
  if (!ids(task.volunteers).includes(user.id)) return { task, finished: false, reason: 'not a volunteer on this task' };
  if (task.task_status === 'FINISHED') return { task, finished: false, reason: 'already finished' };
  await strapi.db.query(TASK).update({
    where: { id: task.id },
    data: { task_status: 'FINISHED', completed_at: new Date(), ...(task.task_status === 'INITIALIZED' ? { publishedAt: new Date() } : {}) },
  });
  // Other open copies of the same repeating task would only nag; the SMS DONE path skips them too.
  if (task.recurring_task) {
    const dupes = await strapi.db.query(TASK).findMany({
      where: { task_status: { $in: ['INITIALIZED', 'PENDING'] }, recurring_task: task.recurring_task.id, garden: task.garden?.id, id: { $ne: task.id } },
    });
    for (const d of dupes) {
      await strapi.service(TASK).updateTaskStatus(d, 'SKIPPED').catch(() => null);
    }
  }
  return { task: await load(task.id), finished: true };
};

module.exports = reserve;
