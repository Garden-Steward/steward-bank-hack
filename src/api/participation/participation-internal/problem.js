'use strict';

module.exports = function problem(code, status = 422, fieldErrors = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.fieldErrors = fieldErrors;
  throw error;
};
