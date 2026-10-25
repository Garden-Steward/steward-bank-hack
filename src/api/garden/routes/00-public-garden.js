'use strict';

module.exports = {
  routes: [{ method: 'GET', path: '/public/gardens', handler: 'public-garden.list', config: { auth: false } }],
};
