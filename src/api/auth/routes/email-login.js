'use strict';

module.exports = {
  routes: [
    { method: 'POST', path: '/auth/email-login/request', handler: 'email-login.request', config: { auth: false } },
    { method: 'POST', path: '/auth/email-login/verify', handler: 'email-login.verify', config: { auth: false } },
  ],
};
