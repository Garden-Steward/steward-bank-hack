'use strict';

const problem = require('./problem');
const emailValue = require('../../auth/join-identity-internal/contact-value');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const arrayFields = ['gardenDocumentIds', 'interestIds', 'offeredSkillIds', 'learningSkillIds', 'availabilityIds', 'taskPreferenceIds'];

function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) problem('INVALID_BODY', 400);
  if (Object.keys(value).some(key => !fields.includes(key))) problem('UNKNOWN_FIELD', 422);
  return value;
}
function text(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0]/.test(value)) problem('VALIDATION_ERROR', 422, { [field]: 'Enter a valid value.' });
  return value;
}
function version(value, field) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) problem('VALIDATION_ERROR', 422, { [field]: 'Use the current profile version.' });
  return value;
}
function request(value) {
  if (typeof value !== 'string' || !UUID.test(value)) problem('INVALID_REQUEST_ID', 400);
  return value;
}
function browser(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) problem('INVALID_BROWSER_SECRET', 400);
  return value;
}
function documentId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]{10,40}$/i.test(value)) problem('EVENT_NOT_FOUND', 404);
  return value;
}
function receiptId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) problem('INVALID_PROOF', 400);
  return value;
}
function body(value, fields) {
  object(value, fields);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16384) problem('BODY_TOO_LARGE', 400);
  request(value.requestId);
  return value;
}
function preferences(value, options) {
  object(value, [...arrayFields, 'experience']);
  const result = {};
  for (const field of arrayFields) {
    const selected = value[field];
    const known = new Set(options.preferences[field].map(option => option.id));
    if (!Array.isArray(selected) || selected.length > 30 || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !known.has(id))) problem('VALIDATION_ERROR', 422, { [field]: 'Choose from the current options.' });
    result[field] = [...selected];
  }
  if (value.experience !== null && !options.preferences.experience.some(option => option.id === value.experience)) problem('VALIDATION_ERROR', 422, { experience: 'Choose from the current options.' });
  result.experience = value.experience;
  return result;
}
function contacts(value, options) {
  const preferredNameRaw = text(value.preferredNameRaw, 'preferredNameRaw', 120);
  const emailRaw = text(value.emailRaw, 'emailRaw', 320);
  try { emailValue(emailRaw); } catch { problem('VALIDATION_ERROR', 422, { emailRaw: 'Enter a valid email address.' }); }
  const phoneRaw = text(value.phoneRaw, 'phoneRaw', 80);
  const phone = phoneRaw.trim();
  const digits = phone.replace(/\D/g, '');
  if (!/^\+?[0-9().\s-]+$/.test(phone) || digits.length < 7 || digits.length > 15) problem('VALIDATION_ERROR', 422, { phoneRaw: 'Enter a phone number, including its area or country code.' });
  return { preferredNameRaw, emailRaw, phoneRaw, preferences: preferences(value.preferences, options) };
}
function draft(value, options) {
  object(value, ['preferredNameRaw', 'emailRaw', 'phoneRaw', 'preferences', 'accessRequestRaw', 'saveReusableProfile', 'profileVersion']);
  if (typeof value.saveReusableProfile !== 'boolean') problem('VALIDATION_ERROR', 422);
  if (value.accessRequestRaw !== null && (typeof value.accessRequestRaw !== 'string' || value.accessRequestRaw.length > 2000 || value.accessRequestRaw.includes('\0'))) problem('VALIDATION_ERROR', 422, { accessRequestRaw: 'Use at most 2,000 characters.' });
  return { ...contacts(value, options), accessRequestRaw: value.accessRequestRaw, saveReusableProfile: value.saveReusableProfile, profileVersion: version(value.profileVersion, 'profileVersion') };
}

module.exports = { object, body, request, browser, documentId, receiptId, contacts, draft, version };
