'use strict';

module.exports = {
  routes: [{ method: 'GET', path: '/public/projects', handler: 'public-project.list', config: { auth: false } }],
};
