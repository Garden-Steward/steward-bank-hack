'use strict';

/**
 * garden-task controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const taskHelper = require('../services/helper');
const reserve = require('../services/reserve');
const { withPublicUserIds } = require('../../../utils/public-user-ids');

// The public task pages count who's signed up; signed out, that's all they get.
const PUBLIC_USER_RELATIONS = ['volunteers', 'reserves'];

// Only the volunteer, reserve and dropped ids leave the server from these endpoints.
const slim = (task) => task && ({
  id: task.id,
  title: task.title,
  task_status: task.task_status,
  max_volunteers: task.max_volunteers,
  completed_at: task.completed_at,
  volunteers: (task.volunteers || []).map((u) => ({ id: u.id })),
  reserves: (task.reserves || []).map((u) => ({ id: u.id })),
  reserve_offer_user: task.reserve_offer_user ?? null,
  dropped: Array.isArray(task.dropped) ? task.dropped : [],
});

module.exports = createCoreController('api::garden-task.garden-task', ({ strapi }) => ({

  /** POST /garden-tasks/:id/leave */
  leaveTask: async (ctx) => {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Sign in to leave a task');
    try {
      const res = await reserve.leaveTask(ctx.params.id, user);
      return { data: slim(res.task), left: res.left };
    } catch (err) {
      return ctx.notFound(err.message);
    }
  },

  /**
   * POST /garden-tasks/:id/reserve
   * Body: { data: { phoneNumber?: string } }. Signed-in callers join as themselves.
   * A phone number that isn't a member of the garden gets the same registration
   * invite as a sign-up would.
   */
  joinReserve: async (ctx) => {
    const data = ctx.request.body?.data || {};
    let user = ctx.state.user;
    const task = await strapi.db.query('api::garden-task.garden-task').findOne({ where: { id: ctx.params.id }, populate: ['garden'] });
    if (!task) return ctx.notFound('Task not found');
    if (!user) {
      if (!data.phoneNumber) return ctx.badRequest('Sign in or give a phone number');
      user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { phoneNumber: `+1${data.phoneNumber}` }, populate: ['gardens'] });
      const member = user?.gardens?.some((g) => g.id === task.garden?.id);
      if (!user || !member) return await taskHelper.inviteUserTask({ phoneNumber: `+1${data.phoneNumber}`, task });
    }
    const res = await reserve.join(task.id, user);
    return { data: slim(res.task), joined: res.joined, position: res.position, reason: res.reason };
  },

  /** DELETE /garden-tasks/:id/reserve */
  leaveReserve: async (ctx) => {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Sign in to leave the reserve list');
    try {
      const res = await reserve.leave(ctx.params.id, user);
      return { data: slim(res.task) };
    } catch (err) {
      return ctx.notFound(err.message);
    }
  },

  /** POST /garden-tasks/:id/finish */
  finishTask: async (ctx) => {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Sign in to finish a task');
    try {
      const res = await reserve.finish(ctx.params.id, user);
      if (!res.finished) return ctx.badRequest(res.reason);
      return { data: slim(res.task), finished: true };
    } catch (err) {
      return ctx.notFound(err.message);
    }
  },

  async find(ctx) {
    const response = await super.find(ctx);
    return withPublicUserIds(strapi, 'api::garden-task.garden-task', ctx, response, PUBLIC_USER_RELATIONS);
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    return withPublicUserIds(strapi, 'api::garden-task.garden-task', ctx, response, PUBLIC_USER_RELATIONS);
  },

  /**
   * Active tasks for the authenticated user across all gardens.
   *
   * GET /garden-tasks/user
   * Used by the dashboard (GardensView) to list the user's cross-garden tasks.
   */
  userTasks: async (ctx) => {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized('You must be logged in to view your tasks');
    }

    const tasks = await strapi.db.query('api::garden-task.garden-task').findMany({
      where: {
        volunteers: user.id,
        task_status: { $in: ['INITIALIZED', 'STARTED', 'PENDING'] }
      },
      populate: ['garden', 'primary_image', 'volunteers', 'instruction', 'recurring_task']
    });

    return { data: tasks };
  },

  /**
   * RSVP to a garden task via phone number or userId
   *
   * POST /garden-tasks/rsvp/:id
   * Body: { data: { userId?: number, phoneNumber?: string } }
   *
   * Flow:
   * - If userId: direct assignment (user already authenticated)
   * - If phoneNumber:
   *   - Check if user exists and is garden member
   *   - If not: send SMS invite to register
   *   - If yes: assign to task
   *
   * Returns:
   * - For registered users: { success, task, instruction }
   * - For unregistered: { success, body, needsRegistration, garden }
   */
  rsvpTask: async (ctx) => {
    console.log("task rsvp: ", ctx.params, ctx.request.body);
    const { data } = ctx.request.body;

    if (!data) {
      return ctx.badRequest('Missing data in request body');
    }

    if (!data.userId && !data.phoneNumber) {
      return ctx.badRequest('Must provide either userId or phoneNumber');
    }

    // Find user by userId or phoneNumber
    const userQuery = data.userId
      ? { id: data.userId }
      : { phoneNumber: `+1${data.phoneNumber}` };

    const user = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: userQuery,
      populate: ['gardens', 'instructions']
    });

    // Fetch the task with garden info
    const task = await strapi.db.query("api::garden-task.garden-task").findOne({
      where: { id: ctx.params.id },
      populate: ['garden', 'volunteers', 'instruction', 'instruction.card', 'recurring_task', 'recurring_task.instruction', 'recurring_task.instruction.card', 'primary_image']
    });

    if (!task) {
      return ctx.notFound('Task not found');
    }

    if (!task.garden) {
      return ctx.badRequest('Task has no associated garden');
    }

    // Check if user is already a member of the garden
    const alreadyMember = user?.gardens?.some(g => g.id === task.garden.id);

    // If authenticated via userId, directly RSVP
    if (data.userId) {
      return await taskHelper.rsvpTask(ctx.params.id, {
        userId: data.userId,
        user,
        task
      });
    }

    // Phone number flow
    if (data.phoneNumber) {
      if (!user || !alreadyMember) {
        // User doesn't exist or isn't a garden member - invite them
        console.log("inviting user to task");
        return await taskHelper.inviteUserTask({
          phoneNumber: `+1${data.phoneNumber}`,
          task
        });
      } else {
        // User is already a member of the garden - safe to RSVP
        return await taskHelper.rsvpTask(ctx.params.id, {
          userId: user.id,
          user,
          task
        });
      }
    }
  }

}));
