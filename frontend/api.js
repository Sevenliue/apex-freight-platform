/* api.js — REST wrapper for the Apex Freight & Shipping Canada backend.
   The backend serves these files statically, so the API is on the SAME origin.
   No dependencies. */

const API_BASE_URL = ''; // same origin; set to full URL only if API is hosted separately

/* ---- Shipper account session -------------------------------------------
   The server issues an opaque session token on signup/login. It is stored
   in localStorage and sent as `Authorization: Bearer <token>` on every API
   call. Public flows (rating, guest quotes) work with or without it. */
const TOKEN_KEY = 'apex_auth_token';

export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session just won't persist */
  }
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const token = getAuthToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(API_BASE_URL + path, opts);
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    data = await res.text();
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      (typeof data === 'string' && data) ||
      `Request failed (${res.status})`;
    const err = new Error(String(msg));
    // Callers (quote gating) need the status: 401 = sign in, 402 = quota.
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

/* Billing — subscription plans and quote quotas. */
export function billingStatus() {
  return get('/api/billing/status');
}

export function createCheckout({ tier, billing }) {
  return post('/api/billing/checkout', { tier, billing });
}

export function billingPortal() {
  return post('/api/billing/portal', {});
}

/* Health */
export function getHealth() {
  return get('/api/health');
}

/* Shipper accounts. signup/login return { token, user } — the caller is
   expected to persist the token via setAuthToken(). */
export function signup({ name, company, email, password }) {
  return post('/api/auth/signup', { name, company, email, password });
}

export function login({ email, password }) {
  return post('/api/auth/login', { email, password });
}

export function logout() {
  return post('/api/auth/logout', {});
}

export function me() {
  return get('/api/auth/me');
}

/* Rates — packages[] in LBS; accessorials[] are catalog codes. Legacy
   single-parcel {weight, length, width, height} still accepted. region /
   direction / freight_charges / bill_to are the Smart Shipping-style top
   options. */
export function getRates({ origin, destination, parcel, packages, accessorials, shipper, consignee, user_id, region, direction, freight_charges, bill_to }) {
  return post('/api/rates', { origin, destination, parcel, packages, accessorials, shipper, consignee, user_id, region, direction, freight_charges, bill_to });
}

/* Saved quotes + accessorial catalog. */
export function getAccessorialCatalog() {
  return get('/api/quotes/accessorials');
}

export function saveQuote(id, name) {
  return post(`/api/quotes/${encodeURIComponent(id)}/save`, { name });
}

export function listSavedQuotes(user_id) {
  return get('/api/quotes/saved' + (user_id ? `?user_id=${encodeURIComponent(user_id)}` : ''));
}

export function getQuote(id) {
  return get(`/api/quotes/${encodeURIComponent(id)}`);
}

/* Complete a shipment (book label or schedule pickup) + printable BOL. */
export function completeShipment({ shipment_id, rate_id, shipper, consignee, references, delivery_notes, user_id, region, direction, freight_charges, bill_to }) {
  return post('/api/shipments/complete', { shipment_id, rate_id, shipper, consignee, references, delivery_notes, user_id, region, direction, freight_charges, bill_to });
}

/* Buy a label for a rated shipment. */
export function buyLabel(rate_id, shipment_id) {
  return post('/api/shipments/buy', { rate_id, shipment_id });
}

/* Tracking. */
export function trackShipment(code, carrier) {
  let path = `/api/tracking/${encodeURIComponent(code)}`;
  if (carrier) path += `?carrier=${encodeURIComponent(carrier)}`;
  return get(path);
}

/* EasyPost live endpoints. Each answers { configured: false } when no
   EASYPOST_API_KEY is set on the server. */
export function getEasypostRates(params) {
  return post('/api/easypost/rates', params);
}

export function buyEasypostLabel(shipment_id, rate_id) {
  return post('/api/easypost/buy', { shipment_id, rate_id });
}

export function trackEasypost(code, carrier) {
  let path = `/api/easypost/track/${encodeURIComponent(code)}`;
  if (carrier) path += `?carrier=${encodeURIComponent(carrier)}`;
  return get(path);
}

/* Webhooks — invoked by the carrier API, not the UI; included for completeness. */
export function easypostWebhook(payload) {
  return post('/api/webhooks/easypost', payload);
}

/* Load board */
export function createLoad(load) {
  return post('/api/loads/create', load);
}

export function listOpenLoads() {
  return get('/api/loads/open');
}

export function submitBid({ shipment_posting_id, carrier_id, bid_amount, estimated_transit_days, notes }) {
  return post('/api/bids/submit', {
    shipment_posting_id,
    carrier_id,
    bid_amount,
    estimated_transit_days,
    notes,
  });
}

export function acceptBid({ bid_id, shipper_id, payment_method_id }) {
  return post('/api/bids/accept', { bid_id, shipper_id, payment_method_id });
}

export function attachProbill(loadId, carrier_probill_number) {
  return post(`/api/loads/${encodeURIComponent(loadId)}/probill`, {
    carrier_probill_number,
  });
}

/* Carrier tariffs */
export function uploadCarrierRates(payload) {
  return post('/api/carrier-rates/upload', payload);
}

export function getAccessorials(carrier_id) {
  return get(`/api/carrier-rates/accessorials/${encodeURIComponent(carrier_id)}`);
}

/* Reports */
export function getShipperReport(shipperId, { start_date, end_date, q } = {}) {
  const p = new URLSearchParams();
  if (start_date) p.set('start_date', start_date);
  if (end_date) p.set('end_date', end_date);
  if (q) p.set('q', q);
  const qs = p.toString();
  return get(`/api/reports/shipper/${encodeURIComponent(shipperId)}${qs ? `?${qs}` : ''}`);
}

export function getCarrierReport(carrierId, { start_date, end_date, q } = {}) {
  const p = new URLSearchParams();
  if (start_date) p.set('start_date', start_date);
  if (end_date) p.set('end_date', end_date);
  if (q) p.set('q', q);
  const qs = p.toString();
  return get(`/api/reports/carrier/${encodeURIComponent(carrierId)}${qs ? `?${qs}` : ''}`);
}

/* Admin */
export function getAdminOverview() {
  return get('/api/admin/overview');
}

/* Address book */
export function listAddresses() {
  return get('/api/address-book');
}

export function createAddress(a) {
  return post('/api/address-book', a);
}

export function updateAddress(id, a) {
  return request('PUT', `/api/address-book/${encodeURIComponent(id)}`, a);
}

export function deleteAddress(id) {
  return request('DELETE', `/api/address-book/${encodeURIComponent(id)}`);
}

/* Carriers + exclusions */
export function listCarriers() {
  return get('/api/carriers');
}

export function createCarrier(c) {
  return post('/api/carriers', c);
}

export function updateCarrier(id, c) {
  return request('PUT', `/api/carriers/${encodeURIComponent(id)}`, c);
}

export function deleteCarrier(id) {
  return request('DELETE', `/api/carriers/${encodeURIComponent(id)}`);
}

export function listExclusions() {
  return get('/api/carriers/exclusions');
}

export function addExclusion(name) {
  return post('/api/carriers/exclusions', { name });
}

export function removeExclusion(name) {
  return request('DELETE', `/api/carriers/exclusions/${encodeURIComponent(name)}`);
}
