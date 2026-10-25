'use strict';

const { ensureConstraints } = require('../participation-internal/constraints');

module.exports = ({ strapi }) => {
  let storageReady = false;
  return {
    async ensureStorage() {
      storageReady = false;
      await ensureConstraints(strapi);
      storageReady = true;
    },
    assertStorageReady() {
      if (!storageReady) throw new Error('Participation storage is unavailable');
    },
  };
};
