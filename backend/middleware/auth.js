// middleware/auth.js — minimal auth stub.
// Disabled by default. Set the AUTH_TOKEN env var to enable: every /api
// request (except /api/health and /api/webhooks/easypost) must then carry
//   Authorization: Bearer <AUTH_TOKEN>
// otherwise it gets 401. EasyPost webhooks are exempt because EasyPost
// cannot send our bearer token (verify via webhook secret instead).
'use strict';

const config = require('../config');

const EXEMPT = new Set(['/api/health', '/api/webhooks/easypost']);

function authStub(req, res, next) {
  if (!config.authToken) return next(); // disabled by default
  if (EXEMPT.has(req.path)) return next();
  const header = req.headers.authorization || '';
  if (header === `Bearer ${config.authToken}`) return next();
  return res.status(401).json({ error: 'Unauthorized: missing or invalid bearer token' });
}

module.exports = authStub;
