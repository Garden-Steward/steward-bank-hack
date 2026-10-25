'use strict';

const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

module.exports = function emailValue(rawValue) {
  const invalid = () => {
    const error = new Error('A valid email is required');
    error.code = 'INVALID_EMAIL';
    throw error;
  };
  if (typeof rawValue !== 'string' || !rawValue.length || rawValue.length > 320 || /[\r\n\0]/.test(rawValue)) invalid();
  const deliveryValue = rawValue.trim().toLowerCase();
  const local = deliveryValue.split('@')[0];
  if (!EMAIL.test(deliveryValue) || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) invalid();
  return { rawValue, deliveryValue };
};
