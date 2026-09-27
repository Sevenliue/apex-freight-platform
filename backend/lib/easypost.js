// lib/easypost.js — thin EasyPost v2 wrapper using Node's built-in fetch.
// HTTP Basic auth with the API key as username (empty password).
// The key lives server-side only (config.easypostKey) and is never exposed
// to the frontend. When EASYPOST_API_KEY is unset, isEnabled() is false and
// the API helpers throw a NOT_CONFIGURED error; routes translate that into
// a clean { configured: false } response.
'use strict';

const config = require('../config');

const API_BASE = 'https://api.easypost.com/v2';
const LB_TO_OZ = 16;

function isEnabled() {
  return !!config.easypostKey;
}

function notConfiguredError() {
  const err = new Error('EASYPOST_API_KEY is not set');
  err.code = 'NOT_CONFIGURED';
  return err;
}

async function api(path, { method = 'GET', body } = {}) {
  const key = config.easypostKey;
  if (!key) throw notConfiguredError();

  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    const epErr = data && data.error;
    const msg =
      (epErr && (epErr.message || epErr.code)) ||
      `EasyPost request failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.code = 'EASYPOST_API_ERROR';
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// Convert a parcel spec in pounds/inches to EasyPost's ounces/inches shape.
function toParcel({ weight_lbs, length, width, height }) {
  const parcel = { weight: Math.max(0.1, Number(weight_lbs) * LB_TO_OZ) };
  if (length != null && Number(length) > 0) parcel.length = Number(length);
  if (width != null && Number(width) > 0) parcel.width = Number(width);
  if (height != null && Number(height) > 0) parcel.height = Number(height);
  return parcel;
}

function toAddress({ street1, city, state, zip, country }) {
  const addr = { city, state, country: country || 'CA' };
  if (street1) addr.street1 = street1;
  if (zip) addr.zip = zip;
  return addr;
}

// Creates an EasyPost shipment and returns it with its rate list.
// `parcels` is an array of { weight_lbs, length, width, height }.
async function createShipment({ from, to, parcels }) {
  const parcelPayload = parcels.map(toParcel);
  const body = {
    shipment: {
      to_address: toAddress(to),
      from_address: toAddress(from),
      parcel: parcelPayload.length === 1 ? parcelPayload[0] : parcelPayload,
    },
  };
  return api('/shipments', { method: 'POST', body });
}

// Purchases the label for a rated shipment. Nothing is charged until this
// is called; rating alone is free.
async function buyLabel(shipmentId, rateId) {
  return api(`/shipments/${encodeURIComponent(shipmentId)}/buy`, {
    method: 'POST',
    body: { rate: { id: rateId } },
  });
}

// Trackers: create (POST) then read back (GET) for the freshest status.
async function createTracker(trackingCode, carrier) {
  const tracker = { tracking_code: trackingCode };
  if (carrier) tracker.carrier = carrier;
  return api('/trackers', { method: 'POST', body: { tracker } });
}

async function getTracker(trackerId) {
  return api(`/trackers/${encodeURIComponent(trackerId)}`);
}

async function getTracking(trackingCode, carrier) {
  const created = await createTracker(trackingCode, carrier);
  if (created && created.id) {
    try {
      return await getTracker(created.id);
    } catch {
      return created;
    }
  }
  return created;
}

module.exports = {
  isEnabled,
  createShipment,
  buyLabel,
  createTracker,
  getTracker,
  getTracking,
  toParcel,
};
