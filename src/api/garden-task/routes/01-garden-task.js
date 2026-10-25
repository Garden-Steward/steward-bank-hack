
module.exports = {
  routes: [
    {
      // Must be declared before the core `/garden-tasks/:id` route so "user"
      // isn't swallowed by the findOne `:id` param (which 404s).
      method: 'GET',
      path: '/garden-tasks/user',
      handler: 'garden-task.userTasks',
    },
    {
      method: 'POST',
      path: '/garden-tasks/rsvp/:id',
      handler: 'garden-task.rsvpTask',
    },
    { // "I can't make it": the signed-in user leaves the task's volunteers.
      method: 'POST',
      path: '/garden-tasks/:id/leave',
      handler: 'garden-task.leaveTask',
    },
    { // Reserve list for a full task. Signed in, or a member's phone number.
      method: 'POST',
      path: '/garden-tasks/:id/reserve',
      handler: 'garden-task.joinReserve',
    },
    {
      method: 'DELETE',
      path: '/garden-tasks/:id/reserve',
      handler: 'garden-task.leaveReserve',
    },
    { // A volunteer on the task marks it done from the page.
      method: 'POST',
      path: '/garden-tasks/:id/finish',
      handler: 'garden-task.finishTask',
    },
  ]
}
