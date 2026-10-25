'use strict';

const { ensureConstraints } = require('../participation-internal/constraints');

module.exports = ({ strapi }) => {
  let state = { kind: 'unavailable' };
  return {
    async ensureStorage() {
      if (state.kind === 'checking') return state.promise;
      const promise = ensureConstraints(strapi).then(() => {
        state = { kind: 'ready' };
      }, error => {
        state = { kind: 'unavailable' };
        throw error;
      });
      state = { kind: 'checking', promise };
      return promise;
    },
    assertStorageReady() {
      if (state.kind !== 'ready') throw new Error('Participation storage is unavailable');
    },
  };
};
