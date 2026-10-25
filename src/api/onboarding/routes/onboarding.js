'use strict';

// Volunteer onboarding: the public join form and a signed-in volunteer's own profile.
// The /me routes check the JWT themselves, so no role permission needs granting.
module.exports = {
  routes: [
    { method: 'GET', path: '/onboarding/options', handler: 'onboarding.options', config: { auth: false } },
    { method: 'POST', path: '/onboarding/join', handler: 'onboarding.join', config: { auth: false } },
    { method: 'GET', path: '/onboarding/me', handler: 'onboarding.me', config: { auth: false } },
    { method: 'PUT', path: '/onboarding/me', handler: 'onboarding.updateMe', config: { auth: false } },
  ],
};
