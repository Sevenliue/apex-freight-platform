// routes/places.js — Google Places address autocomplete + details, proxied
// through the backend so the API key never reaches the browser.
//
//   GET /api/places/autocomplete?input=<text>&country=CA
//   GET /api/places/details?place_id=<id>
//
// Key comes ONLY from process.env.GOOGLE_PLACES_API_KEY (see config.placesKey).
// When the key is unset, both endpoints answer HTTP 200 { configured: false }
// and the frontend leaves the street inputs as plain text fields.
// Google-side errors are passed through as { error, status } — the key is
// never included in any response. Endpoints never 500 on missing config.
//
// Implementation choice: the legacy Place Autocomplete / Place Details JSON
// endpoints (simple server-side GETs, no SDK). The Places API (New) needs
// POST + field masks per request and offers nothing extra for this use.
'use strict';

const express = require('express');
const config = require('../config');

const router = express.Router();

const AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

function notConfigured(res) {
  return res.json({
    configured: false,
    message:
      'Address autocomplete is not connected. Set GOOGLE_PLACES_API_KEY on the server to enable it.',
  });
}

function key() {
  return config.placesKey || process.env.GOOGLE_PLACES_API_KEY || '';
}

// GET /api/places/autocomplete?input=...&country=CA
router.get('/autocomplete', async (req, res) => {
  const k = key();
  if (!k) return notConfigured(res);
  const input = String(req.query.input || '').trim();
  if (!input) return res.json({ configured: true, suggestions: [] });
  const country = String(req.query.country || 'CA')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 2);
  const url =
    `${AUTOCOMPLETE_URL}?input=${encodeURIComponent(input)}` +
    `&components=country:${country || 'CA'}` +
    `&types=address&key=${encodeURIComponent(k)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return res.json({
        configured: true,
        error: 'places_error',
        status: data.status,
        message: data.error_message || 'Google Places request failed.',
      });
    }
    const suggestions = (data.predictions || []).map((p) => ({
      place_id: p.place_id,
      description: p.description,
      main_text: p.structured_formatting ? p.structured_formatting.main_text : p.description,
      secondary_text: p.structured_formatting ? p.structured_formatting.secondary_text : '',
    }));
    return res.json({ configured: true, suggestions });
  } catch (e) {
    return res.json({ configured: true, error: 'request_failed', message: String(e.message || e) });
  }
});

// Parse Google address_components into our address block shape.
function parseComponents(components) {
  const get = (type, field) => {
    const c = (components || []).find((x) => (x.types || []).includes(type));
    return c ? c[field || 'long_name'] || '' : '';
  };
  const number = get('street_number');
  const route = get('route');
  const street = [number, route].filter(Boolean).join(' ');
  const city =
    get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_2');
  return {
    street,
    city,
    province: get('administrative_area_level_1', 'short_name'),
    postal: get('postal_code'),
    country: get('country', 'short_name'),
  };
}

// GET /api/places/details?place_id=...
router.get('/details', async (req, res) => {
  const k = key();
  if (!k) return notConfigured(res);
  const placeId = String(req.query.place_id || '').trim();
  if (!placeId) return res.status(400).json({ error: 'place_id is required' });
  const url =
    `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}` +
    `&fields=address_components,formatted_address&key=${encodeURIComponent(k)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (data.status !== 'OK') {
      return res.json({
        configured: true,
        error: 'places_error',
        status: data.status,
        message: data.error_message || 'Google Places request failed.',
      });
    }
    const parsed = parseComponents((data.result || {}).address_components);
    return res.json({
      configured: true,
      formatted_address: (data.result || {}).formatted_address || '',
      ...parsed,
    });
  } catch (e) {
    return res.json({ configured: true, error: 'request_failed', message: String(e.message || e) });
  }
});

module.exports = router;
