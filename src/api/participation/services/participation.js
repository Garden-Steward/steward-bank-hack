'use strict';

const crypto = require('node:crypto');
const input = require('../participation-internal/input');
const problem = require('../participation-internal/problem');
const createOptions = require('../participation-internal/options');
const createEventAccess = require('../participation-internal/event-access');
const createRequests = require('../participation-internal/requests');
const createProfiles = require('../participation-internal/profiles');
const createLegacy = require('../participation-internal/legacy');
const { ensureConstraints } = require('../participation-internal/constraints');

module.exports = ({ strapi }) => {
  let state = { kind: 'unavailable' };
  function assertStorageReady() {
    if (state.kind !== 'ready') throw new Error('Participation storage is unavailable');
  }
  const options = createOptions({ strapi });
  const access = createEventAccess({ strapi });
  const requests = createRequests({ strapi });
  const profiles = createProfiles({ strapi });
  const legacy = createLegacy({ strapi });
  const identity = () => strapi.service('api::auth.join-identity');
  const table = name => strapi.db.metadata.get('api::participation.' + name).tableName;
  const query = name => strapi.db.query('api::participation.' + name);
  const lock = builder => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') builder.forUpdate();
    return builder;
  };
  function now(trx) {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') return trx.raw('clock_timestamp()');
    return trx.raw("(julianday('now') - 2440587.5) * 86400000");
  }
  async function actor(trx, id, writable = true) {
    if (!Number.isSafeInteger(id) || id < 1) problem('INVALID_SESSION', 401);
    const users = strapi.db.metadata.get('plugin::users-permissions.user').tableName;
    const builder = trx(users).where({ id });
    if (writable) lock(builder);
    const row = await builder.first();
    if (!row || row.blocked) problem('INVALID_SESSION', 401);
    return row;
  }
  function json(value) {
    if (typeof value === 'string') return JSON.parse(value);
    return value;
  }
  function date(value) {
    if (value === null || value === undefined) return null;
    return new Date(value).toISOString();
  }
  function receipt(row) {
    const snapshot = json(row.join_snapshot_json);
    let rsvpedAt = date(row.rsvped_at);
    if (snapshot.rsvpTimeKnown === false) rsvpedAt = null;
    return {
      receiptId: row.receipt_id, eventDocumentId: row.event_document_id, version: row.version,
      rsvp: row.rsvp_state, rsvpedAt, checkedInAt: date(row.checked_in_at),
      followup: { state: row.followup_state, dueAt: date(row.due_at), reason: null },
    };
  }
  async function joinOutcome(trx, participationId, { kind, profileSave }) {
    const row = await trx(table('participation')).where({ id: participationId }).first();
    if (!row) problem('RECEIPT_NOT_FOUND', 404);
    const context = await access(trx, row.event_document_id, { joining: false });
    const status = await strapi.service('api::newsletter.newsletter').getAccountStatus(row.user_id);
    let newsletter = 'pending';
    if (['subscribed', 'unsubscribed', 'suppressed'].includes(status.state)) newsletter = status.state;
    if (row.rsvp_state !== 'confirmed') kind = 'unavailable';
    return { kind, event: context.safe, receipt: receipt(row), profileSave, outreach: { sms: 'unchanged', newsletter } };
  }
  async function cached(trx, saved) {
    if (saved.participationId) return { join: await joinOutcome(trx, saved.participationId, saved) };
    if (saved.kind === 'sign_in_required') {
      const intent = await trx(table('join-intent')).where({ receipt_id: saved.intentId }).first();
      if (!intent || (intent.state !== 'completed' && new Date(intent.expires_at).getTime() <= Date.now())) return { join: { kind: 'invalid_proof' } };
      return pendingIntent(trx, intent);
    }
    return { join: saved };
  }
  function describe(trx, actorId, body, operation, value) {
    return identity().describeParticipationRequest(trx, { actorId, browserSecret: body.browserSecret, requestId: body.requestId, operation, input: value });
  }
  async function completeParticipation(trx, context, userId, draft, proofId, contactId) {
    await actor(trx, userId);
    const newsletter = strapi.service('api::newsletter.newsletter');
    await newsletter.ensureAccountSubscription({ userId, verifiedContactId: contactId, disclosureVersion: newsletter.disclosure.version });
    const profileSave = await profiles.forJoin(trx, userId, draft, proofId);
    let row = await lock(trx(table('participation')).where({ event_document_id: context.event.documentId, user_id: userId })).first();
    if (!row) {
      const created = await query('participation').create({ data: {
        receiptId: crypto.randomBytes(32).toString('hex'), eventDocumentId: context.event.documentId,
        gardenDocumentId: context.garden.documentId, userId, joinSnapshotJson: {},
      } });
      row = await trx(table('participation')).where({ id: created.id }).first();
    }
    let kind = 'confirmed';
    if (row.rsvp_state === 'confirmed') kind = 'already_confirmed';
    const snapshot = { preferredNameRaw: draft.preferredNameRaw, emailRaw: draft.emailRaw, phoneRaw: draft.phoneRaw, preferences: draft.preferences };
    if (json(row.join_snapshot_json).rsvpTimeKnown === false) snapshot.rsvpTimeKnown = false;
    let rsvpedAt = row.rsvped_at;
    if (!rsvpedAt) rsvpedAt = new Date();
    const changed = await access.fence(trx, trx(table('participation')).where({ id: row.id, version: row.version }), context).update({
      rsvp_state: 'confirmed', rsvped_at: rsvpedAt, garden_document_id: context.garden.documentId,
      join_snapshot_json: JSON.stringify(snapshot), access_request_raw: draft.accessRequestRaw, version: row.version + 1, updated_at: new Date(),
    });
    if (changed !== 1) problem('EVENT_UNAVAILABLE', 409);
    return { kind, participationId: row.id, profileSave };
  }
  async function pendingIntent(trx, intent) {
    const envelope = json(intent.draft_json);
    if (intent.state === 'completed') return { join: await joinOutcome(trx, intent.participation_id, { kind: 'already_confirmed', profileSave: envelope.completion.profileSave }) };
    if (intent.state === 'sign_in_required') return { join: { kind: 'sign_in_required', intentId: intent.receipt_id, expiresAt: date(intent.expires_at), canResume: true } };
    if (intent.state !== 'pending' || new Date(intent.expires_at).getTime() <= Date.now()) problem('INVALID_PROOF', 400);
    const proof = await trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity' }).first();
    if (!proof) problem('INVALID_PROOF', 400);
    let verification = proof.send_state;
    if (verification === 'pending') verification = 'queued';
    return { join: { kind: 'pending_verification', intentId: intent.receipt_id, proofId: proof.receipt_id, expiresAt: date(proof.expires_at), verification } };
  }
  async function finishIntent(trx, intent, context, draft, account, proofId) {
    const result = await completeParticipation(trx, context, account.userId, draft, proofId, account.verifiedContactId);
    const envelope = { ...json(intent.draft_json), completion: { profileSave: result.profileSave } };
    const changed = await trx(table('join-intent')).where({ id: intent.id, state: 'pending', bound_actor_id: account.userId }).where('expires_at', '>', now(trx)).update({
      state: 'completed', participation_id: result.participationId, completed_at: new Date(), draft_json: JSON.stringify(envelope), updated_at: new Date(),
    });
    if (changed !== 1) problem('INVALID_PROOF', 400);
    return result;
  }
  async function mutation(operation) {
    assertStorageReady();
    const result = await identity().withTransaction(operation);
    if (result?.kind === 'rejected') {
      if (result.code === 'IDENTITY_RATE_LIMITED') problem(result.code, 429);
      problem(result.code, 400);
    }
    if (result.deliveryReceiptId) await identity().deliverEmailProof(result.deliveryReceiptId);
    if (result.pendingIntentId) {
      return strapi.db.transaction(async ({ trx }) => {
        const intent = await trx(table('join-intent')).where({ id: result.pendingIntentId }).first();
        return pendingIntent(trx, intent);
      });
    }
    return result;
  }
  return {
    async ensureStorage() {
      if (state.kind === 'checking') return state.promise;
      const promise = ensureConstraints(strapi).then(async () => {
        if (process.env.PARTICIPATION_ENABLED === 'true') {
          const cutover = await strapi.store({ type: 'plugin', name: 'participation', key: 'cutover-v1' }).get();
          if (!cutover) await legacy.importConfirmed();
        }
        state = { kind: 'ready' };
      }).catch(error => {
        state = { kind: 'unavailable' };
        throw error;
      });
      state = { kind: 'checking', promise };
      return promise;
    },
    assertStorageReady,
    importLegacyConfirmed: () => legacy.importConfirmed(),
    projectConfirmed: (entries, actorId) => legacy.project(entries, actorId),
    prepareLegacyQuery: (params, actorId) => legacy.prepareQuery(params, actorId),
    stripConfirmedPopulate: (uid, params) => legacy.populate(uid, params),
    assertLegacyFilters: (uid, filters) => legacy.rejectNestedConfirmed(uid, filters),
    legacyVisibility: actorId => legacy.visibility(actorId),
    optionalLegacyActor: ctx => legacy.optionalActor(ctx),
    options() { assertStorageReady(); return options.read(); },
    async submit(actorId, eventDocumentId, body, socketPeer) {
      input.documentId(eventDocumentId);
      input.body(body, ['requestId', 'draft', 'browserSecret']); input.browser(body.browserSecret);
      return mutation(async trx => {
        if (actorId !== null) await actor(trx, actorId);
        const descriptor = describe(trx, actorId, body, 'participation:submit:' + eventDocumentId, body.draft);
        const prior = await requests.find(trx, descriptor);
        if (prior) return cached(trx, prior);
        const existing = await lock(trx(table('join-intent')).where({ browser_secret_hash: descriptor.browserKey, request_id: body.requestId })).first();
        if (existing) {
          if (existing.request_hmac !== descriptor.requestHmac || existing.event_document_id !== eventDocumentId) problem('REQUEST_CONFLICT', 409);
          await access(trx, eventDocumentId, { joining: existing.state === 'pending' });
          return pendingIntent(trx, existing);
        }
        const context = await access(trx, eventDocumentId);
        const draft = input.draft(body.draft, await options.read());
        let contact = null;
        if (actorId !== null) contact = await identity().ownedEmail(trx, { actorId, rawValue: draft.emailRaw });
        if (contact) {
          const result = await completeParticipation(trx, context, actorId, draft, contact.proofId, contact.contactId);
          await requests.save(descriptor, result);
          return cached(trx, result);
        }
        const intent = await query('join-intent').create({ data: {
          receiptId: crypto.randomBytes(32).toString('hex'), eventDocumentId, boundActorId: actorId,
          browserSecretHash: descriptor.browserKey, requestId: body.requestId, requestHmac: descriptor.requestHmac,
          draftJson: { version: 1, draft, submissionActorId: actorId }, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        } });
        const proof = await identity().requestEmailProof(trx, { ...body, actorId, purpose: 'join_identity', intentId: intent.id, rawValue: draft.emailRaw, socketPeer, requestInput: { eventDocumentId, draft } });
        return { pendingIntentId: intent.id, deliveryReceiptId: proof.delivery.requestReceiptId };
      });
    },
    async completeProof(actorId, intentReceiptId, body) {
      input.receiptId(intentReceiptId);
      input.body(body, ['requestId', 'browserSecret', 'code']); input.browser(body.browserSecret);
      if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) problem('INVALID_PROOF', 400);
      return mutation(async trx => {
        if (actorId !== null) await actor(trx, actorId);
        const descriptor = describe(trx, actorId, body, 'participation:verify:' + intentReceiptId, { code: body.code });
        const prior = await requests.find(trx, descriptor);
        if (prior) return cached(trx, prior);
        const intent = await lock(trx(table('join-intent')).where({ receipt_id: intentReceiptId, browser_secret_hash: descriptor.browserKey })).first();
        if (!intent || intent.state !== 'pending' || new Date(intent.expires_at).getTime() <= Date.now()) return { join: { kind: 'invalid_proof' } };
        const envelope = json(intent.draft_json);
        if (envelope.submissionActorId !== null && envelope.submissionActorId !== actorId) problem('ACCOUNT_CHANGED', 409);
        const context = await access(trx, intent.event_document_id);
        const draft = input.draft(envelope.draft, await options.read());
        const proofs = await trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity' }).limit(2);
        if (proofs.length !== 1) problem('INVALID_PROOF', 400);
        const verified = await identity().consumeEmailProof(trx, { ...body, purpose: 'join_identity', intentId: intent.id, proofId: proofs[0].receipt_id });
        if (verified.kind !== 'verified') {
          const result = { kind: 'invalid_proof' };
          const current = await trx(table('contact-proof')).select('attempts').where({ id: proofs[0].id }).first();
          if (current && current.attempts > proofs[0].attempts) await requests.save(descriptor, result);
          return { join: result };
        }
        const account = await identity().resolveFreshJoinAccount(trx, { proofId: verified.proof.id });
        if (account.kind === 'sign_in_required') {
          const result = { kind: 'sign_in_required', intentId: intent.receipt_id, expiresAt: date(intent.expires_at), canResume: true };
          await requests.save(descriptor, result); return { join: result };
        }
        if (actorId !== null && actorId !== account.userId) problem('ACCOUNT_CHANGED', 409);
        const result = await finishIntent(trx, intent, context, draft, account, verified.proof.id);
        await requests.save(descriptor, result);
        const outcome = await cached(trx, result);
        if (actorId === null && envelope.submissionActorId === null) outcome.sessionActorId = account.userId;
        return outcome;
      });
    },
    async resend(intentReceiptId, body, socketPeer) {
      input.receiptId(intentReceiptId);
      input.body(body, ['requestId', 'browserSecret']); input.browser(body.browserSecret);
      return mutation(async trx => {
        const descriptor = describe(trx, null, body, 'participation:resend:' + intentReceiptId, {});
        const intent = await lock(trx(table('join-intent')).where({ receipt_id: intentReceiptId, browser_secret_hash: descriptor.browserKey, state: 'pending' }).where('expires_at', '>', now(trx))).first();
        if (!intent) problem('INVALID_PROOF', 400);
        await access(trx, intent.event_document_id);
        const envelope = json(intent.draft_json);
        if (envelope.submissionActorId !== null) await actor(trx, envelope.submissionActorId);
        const proofs = await trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity' }).limit(2);
        if (proofs.length !== 1) problem('INVALID_PROOF', 400);
        const proof = await identity().resendEmailProof(trx, { ...body, purpose: 'join_identity', intentId: intent.id, proofId: proofs[0].receipt_id, actorId: envelope.submissionActorId, socketPeer });
        return { pendingIntentId: intent.id, deliveryReceiptId: proof.delivery.requestReceiptId };
      });
    },
    async resume(actorId, intentReceiptId, body) {
      input.receiptId(intentReceiptId);
      input.body(body, ['requestId', 'browserSecret']); input.browser(body.browserSecret);
      return mutation(async trx => {
        await actor(trx, actorId);
        const descriptor = describe(trx, actorId, body, 'participation:resume:' + intentReceiptId, {});
        const prior = await requests.find(trx, descriptor);
        if (prior) return cached(trx, prior);
        const intent = await lock(trx(table('join-intent')).where({ receipt_id: intentReceiptId, browser_secret_hash: descriptor.browserKey })).first();
        if (!intent) problem('ACCOUNT_CHANGED', 409);
        const context = await access(trx, intent.event_document_id);
        const draft = input.draft(json(intent.draft_json).draft, await options.read());
        const account = await identity().resumeJoinAccount(trx, { intentId: intent.id, actorId, browserSecret: body.browserSecret });
        const proof = await trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity' }).whereNotNull('consumed_at').first();
        const result = await finishIntent(trx, intent, context, draft, account, proof.id);
        await requests.save(descriptor, result);
        return cached(trx, result);
      });
    },
    async readOwnProfile(actorId) {
      assertStorageReady();
      return strapi.db.transaction(async ({ trx }) => { await actor(trx, actorId, false); return profiles.read(trx, actorId); });
    },
    async saveOwnProfile(actorId, body) {
      input.body(body, ['requestId', 'version', 'preferredNameRaw', 'emailRaw', 'phoneRaw', 'preferences']);
      return mutation(async trx => {
        await actor(trx, actorId);
        const descriptor = describe(trx, actorId, body, 'participation:profile', body);
        const prior = await requests.find(trx, descriptor);
        if (prior) return { profile: await profiles.read(trx, actorId) };
        const edit = { ...input.contacts(body, await options.read()), version: input.version(body.version, 'version') };
        const profile = await profiles.update(trx, actorId, edit);
        await requests.save(descriptor, { kind: 'profile_saved' });
        return { profile };
      });
    },
    async ownReceipt(actorId, eventDocumentId) {
      input.documentId(eventDocumentId);
      assertStorageReady();
      return strapi.db.transaction(async ({ trx }) => {
        await actor(trx, actorId, false); await access(trx, eventDocumentId, { joining: false });
        const row = await trx(table('participation')).where({ user_id: actorId, event_document_id: eventDocumentId }).first();
        if (!row) return null;
        return receipt(row);
      });
    },
    async legacyRsvp(actorId, eventId, data) {
      input.object(data, ['userId']);
      if (Object.hasOwn(data, 'userId') && String(data.userId) !== String(actorId)) problem('ACCOUNT_CHANGED', 409);
      return mutation(async trx => {
        await actor(trx, actorId);
        let documentId = String(eventId);
        if (/^[0-9]+$/.test(documentId)) {
          if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) < 1 || Number(eventId) > 2147483647) problem('EVENT_NOT_FOUND', 404);
          const event = await strapi.db.query('api::volunteer-day.volunteer-day').findOne({ where: { id: Number(eventId) }, select: ['documentId'] });
          if (!event) problem('EVENT_NOT_FOUND', 404);
          documentId = event.documentId;
        }
        const context = await access(trx, documentId);
        const existing = await trx(table('participation')).where({ event_document_id: documentId, user_id: actorId, rsvp_state: 'confirmed' }).first();
        if (existing) return { join: await joinOutcome(trx, existing.id, { kind: 'already_confirmed', profileSave: 'not_requested' }) };
        const profile = await profiles.read(trx, actorId);
        if (!profile) problem('DETAILS_REQUIRED', 422);
        const contact = await identity().ownedEmail(trx, { actorId, rawValue: profile.emailRaw });
        if (!contact) problem('DETAILS_REQUIRED', 422);
        const draft = input.draft({ preferredNameRaw: profile.preferredNameRaw, emailRaw: profile.emailRaw, phoneRaw: profile.phoneRaw, preferences: profile.preferences, accessRequestRaw: null, saveReusableProfile: false, profileVersion: profile.version }, await options.read());
        const result = await completeParticipation(trx, context, actorId, draft, contact.proofId, contact.contactId);
        return cached(trx, result);
      });
    },
    async listOwn(actorId, { page = 1, pageSize = 100 } = {}) {
      assertStorageReady();
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || (page - 1) * pageSize > 100000) problem('INVALID_PAGINATION', 400);
      return strapi.db.transaction(async ({ trx }) => {
        await actor(trx, actorId, false);
        const base = () => trx(table('participation')).where({ user_id: actorId });
        const total = Number((await base().count('* as count').first()).count);
        const rows = await base().orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }]).offset((page - 1) * pageSize).limit(pageSize);
        return { data: rows.map(receipt), meta: { pagination: { page, pageSize, pageCount: Math.ceil(total / pageSize), total } } };
      });
    },
  };
};
