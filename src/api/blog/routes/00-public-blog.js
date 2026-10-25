'use strict';

module.exports = {
  routes: [
    { method: 'GET', path: '/public/blogs', handler: 'public-blog.list', config: { auth: false } },
    { method: 'GET', path: '/public/blogs/:slug', handler: 'public-blog.detail', config: { auth: false } },
  ],
};
