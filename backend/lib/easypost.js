// lib/easypost.js — lazy EasyPost client. Returns null when EASYPOST_API_KEY
// is not set; routes then answer 501 with a clear message.
'use strict';

const config = require('../config');

function getClient() {
  if (!config.easypostKey) return null;
  const EasyPostClient = require('@easypost/api');
  return new EasyPostClient(config.easypostKey);
}

function isEnabled() {
  return !!config.easypostKey;
}

module.exports = { getClient, isEnabled };
