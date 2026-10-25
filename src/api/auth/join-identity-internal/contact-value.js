'use strict';

const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

module.exports = function emailValue(rawValue) {
  const invalid = () => {
    const error = new Error('A valid email is required');
    error.code = 'INVALID_EMAIL';
    throw error;
  };
  if (typeof rawValue !== 'string' || !rawValue.length || rawValue.length > 320 || /[\r\n\0]/.test(rawValue)) invalid();
  const trimmed = rawValue.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator < 1) invalid();
  const local = trimmed.slice(0, separator);
  const deliveryValue = local + '@' + trimmed.slice(separator + 1).toLowerCase();
  if (!EMAIL.test(deliveryValue) || deliveryValue.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) invalid();
  return { rawValue, deliveryValue };
};
