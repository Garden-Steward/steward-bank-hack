'use strict';

const createHttp = require('../../participation/participation-internal/http');

module.exports = ({ strapi }) => {
  const http = createHttp({ strapi });
  const service = () => strapi.service('api::auth.email-login');
  return {
    request: ctx => http.run(ctx, async () => {
      const data = await service().request(ctx.request.body, ctx.req.socket.remoteAddress);
      ctx.status = 202; ctx.body = { data };
    }),
    verify: ctx => http.run(ctx, async () => {
      const actorId = await service().verify(ctx.request.body);
      ctx.body = { data: { session: await http.session(actorId) } };
    }),
  };
};
