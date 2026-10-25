'use strict';

const crypto = require('node:crypto');
const { isIP } = require('node:net');
const PURPOSES = new Set(['join_identity', 'email_login', 'profile_email', 'profile_phone']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const codeValue = value => typeof value === 'string' && /^\d{8}$/.test(value);
const invalid = () => new Error('Invalid proof material');

function context(proof) {
  if (!proof || !PURPOSES.has(proof.purpose) || typeof proof.receiptId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(proof.receiptId) || !Number.isSafeInteger(proof.generation) || proof.generation < 1 ||
      !hex(proof.destinationKey) || !hex(proof.browserSecretHash)) throw invalid();
  return JSON.stringify(['v1', proof.purpose, proof.receiptId, proof.generation, proof.destinationKey, proof.browserSecretHash]);
}

module.exports = function createProofCrypto(masterHex) {
  if (!hex(masterHex)) throw invalid();
  const master = Buffer.from(masterHex, 'hex');
  const derive = label => Buffer.from(crypto.hkdfSync('sha256', master, 'garden-steward-proof-v1', label, 32));
  const destinationSecret = derive('destination');
  const browserSecret = derive('browser');
  const codeSecret = derive('code');
  const payloadSecret = derive('payload');
  const networkSecret = derive('network');
  const requestSecret = derive('request');
  const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
  function codeHash(proof, code) {
    if (!codeValue(code)) throw invalid();
    return hmac(codeSecret, JSON.stringify([context(proof), code]));
  }
  return {
    destinationKey(channel, deliveryValue) {
      if (!['email', 'sms'].includes(channel) || typeof deliveryValue !== 'string' || !deliveryValue.length || deliveryValue.length > 320) throw invalid();
      return hmac(destinationSecret, JSON.stringify(['v1', channel, deliveryValue]));
    },
    browserHash(value) {
      if (!hex(value)) throw invalid();
      return hmac(browserSecret, value);
    },
    networkHash(address) {
      if (typeof address !== 'string' || !isIP(address)) throw invalid();
      return hmac(networkSecret, address);
    },
    requestHash(canonicalInput) {
      if (typeof canonicalInput !== 'string' || !canonicalInput.length || canonicalInput.length > 32768) throw invalid();
      return hmac(requestSecret, canonicalInput);
    },
    generateCode() {
      return String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    },
    codeHash,
    matchesCode(proof, code) {
      if (!codeValue(code) || !hex(proof?.codeHmac)) return false;
      return crypto.timingSafeEqual(Buffer.from(codeHash(proof, code), 'hex'), Buffer.from(proof.codeHmac, 'hex'));
    },
    seal(proof, deliveryValue, code) {
      if (typeof deliveryValue !== 'string' || !deliveryValue.length || deliveryValue.length > 320 || !codeValue(code)) throw invalid();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', payloadSecret, iv);
      cipher.setAAD(Buffer.from(context(proof)));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ deliveryValue, code }), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    open(proof, payload) {
      try {
        if (typeof payload !== 'string' || payload.length > 4096) throw invalid();
        const parts = payload.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        if (iv.length !== 12 || tag.length !== 16) throw invalid();
        const decipher = crypto.createDecipheriv('aes-256-gcm', payloadSecret, iv);
        decipher.setAAD(Buffer.from(context(proof)));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
        const decoded = JSON.parse(plaintext.toString('utf8'));
        if (!codeValue(decoded.code) || typeof decoded.deliveryValue !== 'string' || !decoded.deliveryValue.length || decoded.deliveryValue.length > 320) throw invalid();
        return decoded;
      } catch {
        throw invalid();
      }
    },
  };
};
