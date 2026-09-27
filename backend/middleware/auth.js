// middleware/auth.js — API-token gate + session enrichment.
//
// Disabled by default. Set the AUTH_TOKEN env var to enable: every /api
// request (except /api/health and /api/webhooks/easypost) must then carry
//   Authorization: Bearer <AUTH_TOKEN>
// or a valid shipper session token (see lib/session.js); otherwise it gets
// 401. EasyPost webhooks are exempt because EasyPost cannot send our Bearer <redacted>
// (verify via webhook secret instead).
'use strict';

const config = require('../config');
const sessionLib = require('../lib/session');

const EXEMPT = new Set(['/health', '/webhooks/easypost']);
// NOTE: paths are relative to the '/api' mount point (req.path inside this
// middleware is stripped of the mount prefix).

async function authStub(req, res, next) {
  if (!config.authToken) return next(); // disabled by default
  if (EXEMPT.has(req.path)) return next();
  const header = req.headers.authorization || '';
  if (header === `Bearer ${config.authToken}`) return next();
  // Alongside the API token: a live user session also passes.
  const user = await sessionLib.lookupSession(header);
  if (user) {
    req.user = user;
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: missing or invalid Bearer <redacted>' });
}

module.exports = authStub;
