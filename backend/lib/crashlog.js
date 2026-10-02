// lib/crashlog.js — capture process-level crashes without taking the server down.
//
// A single bad request must never kill the whole site (that's the crash-loop
// Seven hit on 2026-10-02: an uncaught exception restarted the Render service
// every couple of minutes). These handlers log the error, keep it in a small
// in-memory ring buffer for diagnosis via GET /api/admin/diag-errors, and let
// the process keep serving. Node's default (exit on unhandled rejection) is
// the right call for a stateless worker, but for this single-instance web
// service, staying up with a logged error is strictly better than a 502 loop.
'use strict';

const MAX = 20;
const log = [];

function capture(type, err) {
  try {
    log.push({
      at: new Date().toISOString(),
      type,
      message: String((err && err.message) || err),
      stack: String((err && err.stack) || err).slice(0, 4000),
    });
    if (log.length > MAX) log.shift();
  } catch (_) {
    /* never let the crash reporter crash */
  }
  console.error(`[fatal] ${type}:`, (err && err.stack) || err);
}

function install() {
  process.on('unhandledRejection', (reason) => capture('unhandledRejection', reason));
  process.on('uncaughtException', (err) => capture('uncaughtException', err));
}

function list() {
  return log.slice();
}

// Request tracing: record stage markers for recent requests so a hang can be
// pinpointed (which stage never completed). Ring buffer, last 20.
const traces = [];
function startTrace(label, meta) {
  const t = {
    at: new Date().toISOString(),
    label,
    meta: meta || {},
    stages: [],
    done: false,
  };
  try {
    traces.push(t);
    if (traces.length > 20) traces.shift();
  } catch (_) {}
  return {
    stage(name) {
      try { t.stages.push({ at: new Date().toISOString(), name }); } catch (_) {}
    },
    done() { t.done = true; },
  };
}
function listTraces() {
  return traces.slice();
}

module.exports = { install, capture, list, startTrace, listTraces };
