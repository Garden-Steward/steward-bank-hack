'use strict';

module.exports = {
  routes: [
    { method: 'GET', path: '/participation/options', handler: 'participation.options', config: { auth: false } },
    { method: 'GET', path: '/participation/me/profile', handler: 'participation.profile', config: { auth: false } },
    { method: 'PUT', path: '/participation/me/profile', handler: 'participation.saveProfile', config: { auth: false } },
    { method: 'GET', path: '/participation/me', handler: 'participation.listOwn', config: { auth: false } },
    { method: 'POST', path: '/volunteer-days/:documentId/joins', handler: 'participation.submit', config: { auth: false } },
    { method: 'GET', path: '/volunteer-days/:documentId/joins/me', handler: 'participation.ownReceipt', config: { auth: false } },
    { method: 'POST', path: '/join-intents/:id/verify', handler: 'participation.verify', config: { auth: false } },
    { method: 'POST', path: '/join-intents/:id/resume', handler: 'participation.resume', config: { auth: false } },
    { method: 'POST', path: '/join-intents/:id/resend', handler: 'participation.resend', config: { auth: false } },
  ],
};
