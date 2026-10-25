'use strict';

const emailValue = require('../../src/api/auth/join-identity-internal/contact-value');

module.exports = async function elapsedDestination(strapi, tools, rawValue) {
  const destinationKey = tools.destinationKey('email', emailValue(rawValue).deliveryValue);
  const table = strapi.db.metadata.get('api::participation.participation-request').tableName;
  const elapsed = new Date(Date.now() - 61000);
  await strapi.db.connection(table).where({ rate_destination_key: destinationKey }).where('created_at', '>', elapsed).update({ created_at: elapsed });
};
