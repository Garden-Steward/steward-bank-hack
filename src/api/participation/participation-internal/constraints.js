'use strict';

const MODELS = [
  'join-intent', 'contact-proof', 'verified-contact', 'join-profile', 'participation',
  'consent-receipt', 'sms-destination-state', 'event-participation-setting',
  'participation-attempt', 'participation-request', 'participation-photo-card',
];
const OWNER_INDEX = 'gs_verified_contact_active_owner_unique';

function definitions(strapi, knex) {
  return MODELS.map(name => {
    const uid = 'api::participation.' + name;
    const schema = strapi.contentType(uid);
    const metadata = strapi.db.metadata.get(uid);
    const column = attribute => metadata.attributes[attribute].columnName;
    const sql = (text, values) => knex.raw(text, values).toQuery();
    const checks = [];
    const required = [];
    const unique = [...schema.indexes.filter(index => index.type === 'unique').map(index => index.columns)];
    for (const [attribute, definition] of Object.entries(schema.attributes)) {
      if (!metadata.attributes[attribute]?.columnName || definition.type === 'relation') continue;
      const field = column(attribute);
      if (definition.column?.notNullable) required.push(field);
      if (definition.column?.unique) unique.push([field]);
      if (definition.enum) checks.push(sql('?? IN (' + definition.enum.map(() => '?').join(', ') + ')', [field, ...definition.enum]));
      if (typeof definition.min === 'number') checks.push(sql('?? >= ?', [field, definition.min]));
      if (typeof definition.max === 'number') checks.push(sql('?? <= ?', [field, definition.max]));
    }
    if (name === 'join-intent') checks.push("state <> 'completed' OR (participation_id IS NOT NULL AND completed_at IS NOT NULL)");
    if (name === 'contact-proof') {
      checks.push("purpose <> 'join_identity' OR intent_id IS NOT NULL");
      checks.push("purpose NOT IN ('profile_email', 'profile_phone') OR actor_id IS NOT NULL");
    }
    if (name === 'participation') {
      checks.push("rsvp_state = 'none' OR rsvped_at IS NOT NULL");
      checks.push('(checked_in_at IS NULL) = (token_generation IS NULL)');
      checks.push("followup_state NOT IN ('queued', 'preparing', 'dispatching', 'accepted') OR (checked_in_at IS NOT NULL AND due_at IS NOT NULL AND deadline_at IS NOT NULL AND followup_consent_receipt_id IS NOT NULL)");
      checks.push("followup_state <> 'accepted' OR (provider_sid IS NOT NULL AND accepted_at IS NOT NULL)");
      checks.push('due_at IS NULL OR deadline_at IS NULL OR due_at <= deadline_at');
    }
    if (name === 'consent-receipt') checks.push("action <> 'grant' OR (destination_proof_id IS NOT NULL AND destination_key IS NOT NULL AND stop_epoch IS NOT NULL AND stop_epoch >= 0)");
    if (name === 'event-participation-setting') {
      checks.push('closes_at > opens_at');
      checks.push('qr_expiry IS NULL OR qr_expiry <= closes_at');
      checks.push('(qr_hash IS NULL) = (qr_expiry IS NULL)');
    }
    if (name === 'participation-attempt') checks.push("state <> 'accepted' OR (provider_sid IS NOT NULL AND finished_at IS NOT NULL)");
    return { name, table: metadata.tableName, required, unique, check: checks.map(check => '(' + check + ')').join(' AND ') };
  });
}

function fail(name) {
  throw new Error('Participation storage constraint mismatch: ' + name);
}

async function postgresIndexes(trx, table) {
  const result = await trx.raw(`SELECT idx.relname AS name, i.indisunique AS unique, i.indisvalid AS valid,
    pg_get_expr(i.indpred, i.indrelid) AS predicate,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true) FROM generate_series(1, i.indnatts) n) AS columns
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid WHERE i.indrelid = ?::regclass`, [table]);
  return result.rows;
}

async function postgres(trx, models) {
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext('garden-participation-storage'))");
  const contacts = models.find(model => model.name === 'verified-contact');
  await trx.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??) WHERE ?? IS NULL', [OWNER_INDEX, contacts.table, 'channel', 'destination_key', 'revoked_at']);
  const owner = (await postgresIndexes(trx, contacts.table)).find(index => index.name === OWNER_INDEX);
  if (!owner?.unique || !owner.valid || JSON.stringify(owner.columns) !== JSON.stringify(['channel', 'destination_key']) ||
      String(owner.predicate).replace(/["()\s]/g, '').toLowerCase() !== 'revoked_atisnull') fail(OWNER_INDEX);
  for (const model of models) {
    const columns = await trx('information_schema.columns').select('column_name', 'is_nullable').where({ table_schema: 'public', table_name: model.table });
    for (const required of model.required) if (!columns.some(column => column.column_name === required && column.is_nullable === 'NO')) fail(model.table + '.' + required);
    const indexes = await postgresIndexes(trx, model.table);
    for (const unique of model.unique) {
      if (!indexes.some(index => index.unique && index.valid && !index.predicate && JSON.stringify(index.columns) === JSON.stringify(unique))) fail(model.table + ' unique ' + unique.join(','));
    }
    if (!model.check) continue;
    const name = model.table + '_invariant';
    const probe = 'gs_probe_' + model.name.replace(/-/g, '_');
    await trx.raw('CREATE TEMP TABLE ?? (LIKE ??) ON COMMIT DROP', [probe, model.table]);
    await trx.raw('ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (' + model.check + ')', [probe, name]);
    const query = `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS valid FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ? AND contype = 'c'`;
    const expected = (await trx.raw(query, ['pg_temp.' + probe, name])).rows[0];
    let actual = (await trx.raw(query, [model.table, name])).rows[0];
    if (!actual) {
      await trx.raw('ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (' + model.check + ')', [model.table, name]);
      actual = (await trx.raw(query, [model.table, name])).rows[0];
    }
    if (!actual?.valid || actual.definition !== expected.definition) fail(name);
  }
}

async function sqlite(trx, models) {
  const contacts = models.find(model => model.name === 'verified-contact');
  await trx.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??) WHERE ?? IS NULL', [OWNER_INDEX, contacts.table, 'channel', 'destination_key', 'revoked_at']);
  const owner = (await trx.raw('PRAGMA index_list(??)', [contacts.table])).find(index => index.name === OWNER_INDEX);
  const ownerColumns = await trx.raw('PRAGMA index_info(??)', [OWNER_INDEX]);
  const ownerSql = await trx('sqlite_master').select('sql').where({ type: 'index', name: OWNER_INDEX }).first();
  if (!owner || owner.unique !== 1 || owner.partial !== 1 || JSON.stringify(ownerColumns.map(column => column.name)) !== JSON.stringify(['channel', 'destination_key']) ||
      String(ownerSql?.sql).split(/\bWHERE\b/i).at(-1).replace(/[`"()\s]/g, '').toLowerCase() !== 'revoked_atisnull') fail(OWNER_INDEX);
  for (const model of models) {
    const columns = await trx.raw('PRAGMA table_info(??)', [model.table]);
    for (const required of model.required) if (!columns.some(column => column.name === required && column.notnull === 1)) fail(model.table + '.' + required);
    const indexes = await trx.raw('PRAGMA index_list(??)', [model.table]);
    const nativeKeys = [];
    for (const index of indexes) {
      if (index.unique === 1 && index.partial === 0) nativeKeys.push((await trx.raw('PRAGMA index_info(??)', [index.name])).map(column => column.name));
    }
    for (const unique of model.unique) if (!nativeKeys.some(columns => JSON.stringify(columns) === JSON.stringify(unique))) fail(model.table + ' unique ' + unique.join(','));
    if (!model.check) continue;
    const names = columns.map(column => column.name).sort((a, b) => b.length - a.length);
    const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const identifier = new RegExp('[`"]?\\b(' + escaped.join('|') + ')\\b[`"]?', 'g');
    const expression = model.check.replace(identifier, (_, name) => 'NEW."' + name + '"');
    for (const operation of ['INSERT', 'UPDATE']) {
      const name = model.table + '_invariant_' + operation.toLowerCase();
      const expected = trx.raw('CREATE TRIGGER ?? BEFORE ' + operation + ' ON ?? WHEN NOT (' + expression + ") BEGIN SELECT RAISE(ABORT, 'Participation storage invariant'); END", [name, model.table]).toQuery();
      const existing = await trx('sqlite_master').select('sql').where({ type: 'trigger', name }).first();
      if (!existing) await trx.raw(expected);
      else if (existing.sql.trim() !== expected.trim()) fail(name);
    }
  }
}

async function ensureConstraints(strapi) {
  const knex = strapi.db.connection;
  const models = definitions(strapi, knex);
  const client = knex.client.config.client;
  await knex.transaction(async trx => {
    if (client === 'pg' || client === 'postgres') await postgres(trx, models);
    else if (client === 'sqlite3' || client === 'better-sqlite3') await sqlite(trx, models);
    else throw new Error('Unsupported participation database');
  });
}

module.exports = { ensureConstraints };
