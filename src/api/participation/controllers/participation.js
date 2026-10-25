'use strict';

const createHttp = require('../participation-internal/http');
const input = require('../participation-internal/input');
const problem = require('../participation-internal/problem');

module.exports = ({ strapi }) => {
  const http = createHttp({ strapi });
  const service = () => strapi.service('api::participation.participation');
  function joinStatus(join) {
    if (join.kind === 'invalid_proof') problem('INVALID_PROOF', 400);
    if (join.kind === 'sign_in_required') return 428;
    if (join.kind === 'pending_verification') return 202;
    return 200;
  }
  async function verified(ctx, result) {
    ctx.status = joinStatus(result.join);
    if (ctx.status === 428) { ctx.body = { data: result.join }; return; }
    const data = { join: result.join };
    if (result.sessionActorId) data.session = await http.session(result.sessionActorId);
    ctx.body = { data };
  }
  return {
    options: ctx => http.run(ctx, async () => { ctx.body = { data: await service().options() }; }),
    profile: ctx => http.run(ctx, async () => { ctx.body = { data: await service().readOwnProfile(await http.actor(ctx, true)) }; }),
    saveProfile: ctx => http.run(ctx, async () => { ctx.body = { data: (await service().saveOwnProfile(await http.actor(ctx, true), ctx.request.body)).profile }; }),
    submit: ctx => http.run(ctx, async () => {
      const result = await service().submit(await http.actor(ctx), ctx.params.documentId, ctx.request.body, ctx.req.socket.remoteAddress);
      ctx.status = joinStatus(result.join); ctx.body = { data: result.join };
    }),
    verify: ctx => http.run(ctx, async () => verified(ctx, await service().completeProof(await http.actor(ctx), ctx.params.id, ctx.request.body))),
    resume: ctx => http.run(ctx, async () => verified(ctx, await service().resume(await http.actor(ctx, true), ctx.params.id, ctx.request.body))),
    resend: ctx => http.run(ctx, async () => {
      const result = await service().resend(ctx.params.id, ctx.request.body, ctx.req.socket.remoteAddress);
      ctx.status = joinStatus(result.join); ctx.body = { data: result.join };
    }),
    ownReceipt: ctx => http.run(ctx, async () => { ctx.body = { data: await service().ownReceipt(await http.actor(ctx, true), ctx.params.documentId) }; }),
    listOwn: ctx => http.run(ctx, async () => {
      input.object(ctx.query, ['page', 'pageSize']);
      const pagination = { page: 1, pageSize: 100 };
      for (const key of Object.keys(ctx.query)) {
        if (typeof ctx.query[key] !== 'string' || !/^[1-9]\d*$/.test(ctx.query[key])) problem('INVALID_PAGINATION', 400);
        pagination[key] = Number(ctx.query[key]);
      }
      ctx.body = await service().listOwn(await http.actor(ctx, true), pagination);
    }),
  };
};
