'use strict';

const crypto = require('node:crypto');
const createProofCrypto = require('../join-identity-internal/proof-crypto');
const emailValue = require('../join-identity-internal/contact-value');
const createAccounts = require('../join-identity-internal/accounts');

const TTL = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const REQUEST_RETENTION = 7 * DAY;
const PURPOSES = new Set(['join_identity', 'email_login', 'profile_email']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class AdmissionRejected extends Error {
  constructor(code, retryAfterSeconds = 60) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

module.exports = ({ strapi }) => {
  const transactions = new WeakMap();
  const accounts = createAccounts({ strapi, databaseNow });
  let tools;
  const cryptography = () => {
    if (!tools) tools = createProofCrypto(process.env.PARTICIPATION_IDENTITY_KEY);
    return tools;
  };
  const table = name => strapi.db.metadata.get('api::participation.' + name).tableName;
  const users = () => strapi.db.metadata.get('plugin::users-permissions.user').tableName;
  const lock = query => {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') query.forUpdate();
    return query;
  };
  function databaseNow(trx) {
    const client = strapi.db.connection.client.config.client;
    if (client === 'pg' || client === 'postgres') return trx.raw('clock_timestamp()');
    return trx.raw("(julianday('now') - 2440587.5) * 86400000");
  }
  function liveIntent(trx, query) {
    const proofs = table('contact-proof');
    const intents = table('join-intent');
    return query.where(function () {
      this.whereNull(proofs + '.intent_id').orWhereExists(function () {
        this.select(trx.raw('1')).from(intents)
          .whereRaw('?? = ??', [intents + '.id', proofs + '.intent_id'])
          .where(intents + '.state', 'pending').where(intents + '.expires_at', '>', databaseNow(trx));
      });
    });
  }
  function liveProof(trx, query) {
    return liveIntent(trx, query).where(table('contact-proof') + '.expires_at', '>', databaseNow(trx));
  }
  function requireTransaction(trx) {
    if (!transactions.has(trx)) fail('IDENTITY_TRANSACTION_REQUIRED');
  }
  async function ensureKeyState(trx) {
    const fingerprint = cryptography().requestHash('identity-key-check-v1');
    const key = 'plugin_garden-identity_key-v1-fingerprint';
    const storeTable = strapi.db.metadata.get('strapi::core-store').tableName;
    const rows = await trx(storeTable).where({ key, environment: null, tag: null });
    if (rows.length > 1) fail('IDENTITY_KEY_STATE_INVALID');
    if (rows.length === 1) {
      let stored;
      try { stored = JSON.parse(rows[0].value); } catch { fail('IDENTITY_KEY_STATE_INVALID'); }
      if (rows[0].type !== 'string' || typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) fail('IDENTITY_KEY_STATE_INVALID');
      if (stored !== fingerprint) fail('IDENTITY_KEY_MISMATCH');
      return;
    }
    const proof = await trx(table('contact-proof')).select('id').first();
    const contact = await trx(table('verified-contact')).select('id').first();
    if (proof || contact) fail('IDENTITY_KEY_STATE_MISSING');
    await strapi.store({ type: 'plugin', name: 'garden-identity', key: 'key-v1-fingerprint' }).set({ value: fingerprint });
  }
  async function withTransaction(operation) {
    if (strapi.db.inTransaction()) fail('IDENTITY_FOREIGN_TRANSACTION');
    let completion;
    try {
      const result = await strapi.db.transaction(async ({ trx }) => {
        completion = trx.executionPromise.then(() => ({ ok: true }), error => ({ ok: false, error }));
        const client = strapi.db.connection.client.config.client;
        if (client === 'pg' || client === 'postgres') await trx.raw("SELECT pg_advisory_xact_lock(hashtext('garden-steward-identity-v1'))");
        else if (!['sqlite', 'sqlite3', 'better-sqlite3'].includes(client)) fail('IDENTITY_DATABASE_UNSUPPORTED');
        await ensureKeyState(trx);
        transactions.set(trx, new Set());
        try { return await operation(trx); } finally { transactions.delete(trx); }
      });
      const completed = await completion;
      if (!completed.ok) throw completed.error;
      return result;
    } catch (error) {
      if (error instanceof AdmissionRejected) return { kind: 'rejected', code: error.code, retryAfterSeconds: error.retryAfterSeconds };
      throw error;
    }
  }
  function identity(command, operation, input, browserBound = true) {
    if (typeof command.requestId !== 'string' || !UUID.test(command.requestId)) fail('IDENTITY_INVALID_REQUEST');
    if (command.actorId !== undefined && command.actorId !== null && (!Number.isSafeInteger(command.actorId) || command.actorId < 1)) fail('IDENTITY_INVALID_ACTOR');
    let browserKey = null;
    if (browserBound || !command.actorId) browserKey = cryptography().browserHash(command.browserSecret);
    let scope = 'identity:browser:' + browserKey;
    if (command.actorId) scope = 'identity:actor:' + command.actorId;
    return {
      scope, operation, requestId: command.requestId, browserKey,
      requestHmac: cryptography().requestHash(JSON.stringify(canonical([operation, command.actorId || null, browserKey, input]))),
    };
  }
  async function existingRequest(trx, descriptor) {
    const row = await trx(table('participation-request')).where({ actor_or_browser_scope: descriptor.scope, operation: descriptor.operation, request_id: descriptor.requestId }).first();
    if (!row) return null;
    if (row.request_hmac !== descriptor.requestHmac) fail('IDENTITY_REQUEST_CONFLICT');
    return row;
  }
  async function admit(trx, descriptor, destinationKey, socketPeer) {
    const networkKey = cryptography().networkHash(socketPeer);
    for (const [column, value, hourly, daily] of [
      ['rate_destination_key', destinationKey, 5, 10],
      ['rate_browser_key', descriptor.browserKey, 10, 20],
      ['rate_network_key', networkKey, 500, 2000],
    ]) {
      for (const [window, maximum] of [[3600000, hourly], [DAY, daily]]) {
        const row = await trx(table('participation-request')).where(column, value).where('created_at', '>=', new Date(Date.now() - window)).count('* as count').first();
        if (Number(row.count) >= maximum) throw new AdmissionRejected('IDENTITY_RATE_LIMITED');
      }
    }
    return { destinationKey, browserKey: descriptor.browserKey, networkKey };
  }
  function receiptResult(row) {
    let saved = row.safe_result_json;
    if (typeof saved === 'string') saved = JSON.parse(saved);
    return {
      public: { kind: 'pending_verification', proofId: saved.proofReceiptId, expiresAt: saved.expiresAt, verification: { state: 'pending', resendAfterSeconds: 60 } },
      delivery: { requestReceiptId: row.id, proofId: saved.proofId, generation: saved.generation },
      scopeReceiptId: saved.scopeReceiptId,
    };
  }
  async function saveRequest(descriptor, budget, proof, scopeReceiptId) {
    const saved = await strapi.db.query('api::participation.participation-request').create({ data: {
      actorOrBrowserScope: descriptor.scope, operation: descriptor.operation, requestId: descriptor.requestId, requestHmac: descriptor.requestHmac,
      safeResultJson: { proofId: proof.id, proofReceiptId: proof.receiptId, generation: proof.generation, expiresAt: proof.expiresAt, scopeReceiptId },
      expiresAt: new Date(Date.now() + REQUEST_RETENTION).toISOString(), rateDestinationKey: budget.destinationKey, rateBrowserKey: budget.browserKey, rateNetworkKey: budget.networkKey,
    } });
    return saved.id;
  }
  async function resultFor(trx, id) {
    return receiptResult(await trx(table('participation-request')).where({ id }).first());
  }
  async function activeUser(trx, id) {
    const user = await lock(trx(users()).where({ id })).first();
    if (!user || user.blocked) return null;
    return user;
  }
  async function lockProof(trx, selector) {
    const candidate = await trx(table('contact-proof')).where(selector).first();
    if (!candidate) return null;
    if (candidate.intent_id) {
      const intent = await lock(trx(table('join-intent')).where({ id: candidate.intent_id })).first();
      if (!intent || intent.state !== 'pending' || new Date(intent.expires_at).getTime() <= Date.now()) return null;
    }
    const proof = await lock(trx(table('contact-proof')).where({ id: candidate.id })).first();
    if (!proof || proof.intent_id !== candidate.intent_id) fail('IDENTITY_PROOF_CHANGED');
    return proof;
  }
  const proofContext = proof => ({ receiptId: proof.receipt_id, purpose: proof.purpose, generation: proof.generation, destinationKey: proof.destination_key, browserSecretHash: proof.browser_secret_hash, codeHmac: proof.code_hmac });
  function matchesScope(proof, submission) {
    const browserKey = cryptography().browserHash(submission.browserSecret);
    if (typeof proof.browser_secret_hash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.browser_secret_hash) ||
        !crypto.timingSafeEqual(Buffer.from(proof.browser_secret_hash, 'hex'), Buffer.from(browserKey, 'hex'))) return false;
    if (submission.purpose && proof.purpose !== submission.purpose) return false;
    if (proof.purpose === 'join_identity' && proof.intent_id !== submission.intentId) return false;
    if (proof.purpose === 'profile_email' && proof.actor_id !== submission.actorId) return false;
    return true;
  }
  async function loginActor(trx, destinationKey) {
    const mapping = await trx(table('verified-contact')).where({ channel: 'email', destination_key: destinationKey, revoked_at: null }).first();
    let actorId = 0;
    if (mapping) actorId = mapping.user_id;
    const user = await activeUser(trx, actorId);
    if (!mapping || !user) return null;
    const current = await lock(trx(table('verified-contact')).where({ id: mapping.id, user_id: user.id, revoked_at: null, channel: 'email', destination_key: destinationKey })).first();
    if (!current) return null;
    return user.id;
  }
  function issuedData(purpose, rawValue, deliveryValue, destinationKey, browserKey, generation) {
    const receiptId = crypto.randomBytes(32).toString('hex');
    const context = { receiptId, purpose, generation, destinationKey, browserSecretHash: browserKey };
    const code = cryptography().generateCode();
    return {
      receiptId, purpose, rawValue, deliveryValue, destinationKey, browserSecretHash: browserKey,
      generation, codeHmac: cryptography().codeHash(context, code), attempts: 0,
      expiresAt: new Date(Date.now() + TTL).toISOString(), sendState: 'pending',
      sealedPayload: cryptography().seal(context, deliveryValue, code),
    };
  }
  return {
    withTransaction,
    describeParticipationRequest(trx, command) {
      requireTransaction(trx);
      if (typeof command.operation !== 'string' || !command.operation.startsWith('participation:')) fail('IDENTITY_INVALID_REQUEST');
      let browserBound = true;
      if (command.actorId && command.browserSecret === undefined) browserBound = false;
      return identity(command, command.operation, command.input, browserBound);
    },
    async ownedEmail(trx, { actorId, rawValue }) {
      requireTransaction(trx);
      if (!Number.isSafeInteger(actorId) || actorId < 1 || !(await activeUser(trx, actorId))) fail('IDENTITY_ACTOR_UNAVAILABLE');
      const email = emailValue(rawValue);
      const destinationKey = cryptography().destinationKey('email', email.deliveryValue);
      const contact = await lock(trx(table('verified-contact')).where({ user_id: actorId, channel: 'email', destination_key: destinationKey, derivation_version: 1, revoked_at: null })).first();
      if (!contact) return null;
      return { contactId: contact.id, proofId: contact.proof_id };
    },
    async peekEmailProofRequest(trx, command) {
      requireTransaction(trx);
      if (!PURPOSES.has(command.purpose)) fail('IDENTITY_INVALID_PURPOSE');
      const email = emailValue(command.rawValue);
      const descriptor = identity(command, 'identity:request:' + command.purpose, [email.rawValue, command.requestInput || {}]);
      const previous = await existingRequest(trx, descriptor);
      if (previous) return receiptResult(previous);
      return null;
    },
    async requestEmailProof(trx, command) {
      requireTransaction(trx);
      if (!PURPOSES.has(command.purpose)) fail('IDENTITY_INVALID_PURPOSE');
      const email = emailValue(command.rawValue);
      const descriptor = identity(command, 'identity:request:' + command.purpose, [email.rawValue, command.requestInput || {}]);
      const previous = await existingRequest(trx, descriptor);
      if (previous) {
        const result = receiptResult(previous);
        if (command.purpose === 'join_identity') {
          const proof = await trx(table('contact-proof')).select('intent_id').where({ id: result.delivery.proofId }).first();
          if (!proof || proof.intent_id !== command.intentId) fail('IDENTITY_REQUEST_CONFLICT');
        }
        return result;
      }
      const destinationKey = cryptography().destinationKey('email', email.deliveryValue);
      let scopeReceiptId = null;
      if (command.purpose === 'join_identity') {
        const intent = await lock(trx(table('join-intent')).where({ id: command.intentId, browser_secret_hash: descriptor.browserKey, state: 'pending' })).first();
        if (!intent || new Date(intent.expires_at).getTime() <= Date.now()) throw new AdmissionRejected('IDENTITY_SCOPE_UNAVAILABLE');
        if (await trx(table('contact-proof')).where({ intent_id: intent.id, purpose: 'join_identity' }).first()) throw new AdmissionRejected('IDENTITY_PROOF_EXISTS');
        scopeReceiptId = intent.receipt_id;
      }
      let actorId = null;
      if (command.purpose === 'profile_email') {
        if (!command.actorId || !(await activeUser(trx, command.actorId))) throw new AdmissionRejected('IDENTITY_ACTOR_UNAVAILABLE');
        actorId = command.actorId;
      }
      if (command.purpose === 'email_login') actorId = await loginActor(trx, destinationKey);
      const budget = await admit(trx, descriptor, destinationKey, command.socketPeer);
      const data = issuedData(command.purpose, email.rawValue, email.deliveryValue, destinationKey, descriptor.browserKey, 1);
      data.actorId = actorId;
      if (command.purpose === 'join_identity') data.intentId = command.intentId;
      if (command.purpose === 'email_login' && !actorId) data.sealedPayload = null;
      const proof = await strapi.db.query('api::participation.contact-proof').create({ data });
      const requestId = await saveRequest(descriptor, budget, proof, scopeReceiptId);
      return resultFor(trx, requestId);
    },
    async resendEmailProof(trx, command) {
      requireTransaction(trx);
      const descriptor = identity(command, 'identity:resend', [command.proofId, command.purpose ?? null, command.intentId ?? null]);
      const previous = await existingRequest(trx, descriptor);
      if (previous) return receiptResult(previous);
      const proof = await lockProof(trx, { receipt_id: command.proofId });
      if (!proof || !PURPOSES.has(proof.purpose) || !matchesScope(proof, command) || proof.consumed_at || proof.superseded_at) throw new AdmissionRejected('IDENTITY_PROOF_UNAVAILABLE');
      if (Date.now() < new Date(proof.expires_at).getTime() - TTL + 60000) throw new AdmissionRejected('IDENTITY_COOLDOWN');
      if (proof.actor_id && !(await activeUser(trx, proof.actor_id))) throw new AdmissionRejected('IDENTITY_ACTOR_UNAVAILABLE');
      const budget = await admit(trx, descriptor, proof.destination_key, command.socketPeer);
      const context = { ...proofContext(proof), generation: proof.generation + 1 };
      const code = cryptography().generateCode();
      const data = {
        generation: context.generation, code_hmac: cryptography().codeHash(context, code), attempts: 0,
        expires_at: new Date(Date.now() + TTL), send_state: 'pending', attempt_id: null, provider_id: null, updated_at: new Date(),
        sealed_payload: cryptography().seal(context, proof.delivery_value, code),
      };
      if (proof.purpose === 'email_login' && !proof.actor_id) data.sealed_payload = null;
      const changed = await liveIntent(trx, trx(table('contact-proof')).where({ id: proof.id, generation: proof.generation, consumed_at: null, superseded_at: null })).update(data);
      if (changed !== 1) throw new AdmissionRejected('IDENTITY_PROOF_UNAVAILABLE');
      let scopeReceiptId = null;
      if (proof.intent_id) scopeReceiptId = (await trx(table('join-intent')).where({ id: proof.intent_id }).first()).receipt_id;
      const saved = { id: proof.id, receiptId: proof.receipt_id, generation: data.generation, expiresAt: data.expires_at.toISOString() };
      const requestId = await saveRequest(descriptor, budget, saved, scopeReceiptId);
      return resultFor(trx, requestId);
    },
    async consumeEmailProof(trx, submission) {
      requireTransaction(trx);
      if (!PURPOSES.has(submission.purpose)) fail('IDENTITY_INVALID_PURPOSE');
      const proof = await lockProof(trx, { receipt_id: submission.proofId });
      if (!proof || !PURPOSES.has(proof.purpose) || !matchesScope(proof, submission) || proof.consumed_at || proof.superseded_at ||
          new Date(proof.expires_at).getTime() <= Date.now() || proof.attempts >= 5 || !['queued', 'accepted', 'simulated', 'unknown'].includes(proof.send_state)) return { kind: 'invalid_proof' };
      if (proof.purpose === 'profile_email' && !(await activeUser(trx, proof.actor_id))) return { kind: 'invalid_proof' };
      if (proof.purpose === 'email_login' && (!proof.actor_id || (await loginActor(trx, proof.destination_key)) !== proof.actor_id)) return { kind: 'invalid_proof' };
      if (!cryptography().matchesCode(proofContext(proof), submission.code)) {
        await liveProof(trx, trx(table('contact-proof')).where({ id: proof.id, generation: proof.generation, attempts: proof.attempts, consumed_at: null, superseded_at: null })).update({ attempts: proof.attempts + 1, updated_at: new Date() });
        return { kind: 'invalid_proof' };
      }
      const changed = await liveProof(trx, trx(table('contact-proof')).where({ id: proof.id, generation: proof.generation, consumed_at: null, superseded_at: null })).update({ consumed_at: new Date(), sealed_payload: null, updated_at: new Date() });
      if (changed !== 1) return { kind: 'invalid_proof' };
      transactions.get(trx).add(proof.id);
      return { kind: 'verified', proof: { id: proof.id, receiptId: proof.receipt_id, purpose: proof.purpose, actorId: proof.actor_id, intentId: proof.intent_id, rawValue: proof.raw_value, deliveryValue: proof.delivery_value, destinationKey: proof.destination_key, derivationVersion: proof.derivation_version } };
    },
    async resolveFreshJoinAccount(trx, { proofId }) {
      requireTransaction(trx);
      if (!transactions.get(trx).delete(proofId)) fail('IDENTITY_FRESH_PROOF_REQUIRED');
      const proof = await lockProof(trx, { id: proofId });
      if (!proof || proof.purpose !== 'join_identity' || !proof.consumed_at || proof.superseded_at) fail('IDENTITY_PROOF_UNAVAILABLE');
      const intent = await trx(table('join-intent')).where({ id: proof.intent_id, state: 'pending' }).first();
      if (!intent) fail('IDENTITY_SCOPE_UNAVAILABLE');
      const result = await accounts.fresh(trx, proof, intent);
      return result;
    },
    async resumeJoinAccount(trx, { intentId, actorId, browserSecret }) {
      requireTransaction(trx);
      if (!Number.isSafeInteger(intentId) || intentId < 1 || !Number.isSafeInteger(actorId) || actorId < 1) fail('IDENTITY_INVALID_ACTOR');
      return accounts.resume(trx, { intentId, actorId, browserKey: cryptography().browserHash(browserSecret) });
    },
    async deliverEmailProof(requestReceiptId) {
      if (!Number.isSafeInteger(requestReceiptId) || requestReceiptId < 1) fail('IDENTITY_INVALID_REQUEST');
      const claim = await withTransaction(async trx => {
        const request = await trx(table('participation-request')).where({ id: requestReceiptId }).first();
        if (!request || !['identity:resend', 'identity:request:join_identity', 'identity:request:email_login', 'identity:request:profile_email'].includes(request.operation)) return null;
        let saved = request.safe_result_json;
        if (typeof saved === 'string') saved = JSON.parse(saved);
        const proof = await lockProof(trx, { id: saved.proofId, receipt_id: saved.proofReceiptId });
        if (!proof || !PURPOSES.has(proof.purpose) || proof.generation !== saved.generation || proof.consumed_at || proof.superseded_at ||
            new Date(proof.expires_at).getTime() <= Date.now() || proof.send_state !== 'pending' || proof.attempt_id || !proof.sealed_payload) return null;
        if (proof.actor_id && !(await activeUser(trx, proof.actor_id))) return null;
        if (proof.purpose === 'email_login' && (await loginActor(trx, proof.destination_key)) !== proof.actor_id) return null;
        const attemptId = crypto.randomUUID();
        const changed = await liveProof(trx, trx(table('contact-proof')).where({ id: proof.id, generation: proof.generation, send_state: 'pending', attempt_id: null, consumed_at: null, superseded_at: null })).update({ attempt_id: attemptId, send_state: 'queued', sealed_payload: null, updated_at: new Date() });
        if (changed !== 1) return null;
        return { proof, attemptId };
      });
      if (!claim) return { kind: 'not_claimable' };
      let state = 'failed';
      let providerId = null;
      let invoked = false;
      try {
        const payload = cryptography().open(proofContext(claim.proof), claim.proof.sealed_payload);
        if (payload.deliveryValue !== claim.proof.delivery_value || cryptography().destinationKey('email', payload.deliveryValue) !== claim.proof.destination_key) fail('IDENTITY_PAYLOAD_MISMATCH');
        if (strapi.db.inTransaction()) fail('IDENTITY_DELIVERY_IN_TRANSACTION');
        invoked = true;
        const result = await strapi.plugin('email').service('email').send({ to: payload.deliveryValue, subject: 'Your Garden Steward code', text: 'Your Garden Steward code is ' + payload.code + '. It expires in 10 minutes. If you did not request it, ignore this email.' });
        if (result?.simulated === true) state = 'simulated';
        else if (typeof result?.id === 'string' && result.id.length) { state = 'accepted'; providerId = result.id; }
        else state = 'unknown';
      } catch (error) {
        if (invoked) state = 'unknown';
        if ([400, 401, 403, 404, 422].includes(error?.resendError?.statusCode)) state = 'failed';
      }
      const recorded = await withTransaction(async trx => trx(table('contact-proof')).where({ id: claim.proof.id, generation: claim.proof.generation, attempt_id: claim.attemptId, send_state: 'queued' }).update({ send_state: state, provider_id: providerId, sealed_payload: null, updated_at: new Date() }));
      return { kind: 'delivery_result', state, recorded: recorded === 1 };
    },
    async clearExpiredProofPayloads({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('IDENTITY_INVALID_LIMIT');
      return withTransaction(async trx => {
        const rows = await trx(table('contact-proof')).select('id', 'generation').whereNotNull('sealed_payload').where('expires_at', '<=', new Date()).orderBy('id').limit(limit);
        let cleared = 0;
        for (const row of rows) cleared += await trx(table('contact-proof')).where({ id: row.id, generation: row.generation }).where('expires_at', '<=', new Date()).update({ sealed_payload: null, updated_at: new Date() });
        return { cleared };
      });
    },
  };
};
