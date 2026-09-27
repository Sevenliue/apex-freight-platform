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

// Requests time out instead of hanging forever: a stalled network used to
// leave buttons like "Getting rates..." disabled with no error shown.
const REQUEST_TIMEOUT_MS = 60000;
async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const token = getAuthToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  opts.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(API_BASE_URL + path, opts);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Request timed out — please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
export const post = (path, body) => request('POST', path, body);

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

export function getPaymentHistory() {
  return get('/api/billing/payments');
}

export function getPaymentMethod() {
  return get('/api/billing/payment-method');
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
export function getRates({ origin, destination, parcel, packages, accessorials, shipper, consignee, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup, delivery_note_1, delivery_note_2, private_notes, add_insurance, declared_value, pickup_date }) {
  return post('/api/rates', { origin, destination, parcel, packages, accessorials, shipper, consignee, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup, delivery_note_1, delivery_note_2, private_notes, add_insurance, declared_value, pickup_date });
}

/* Saved quotes + accessorial catalog. */
export function getAccessorialCatalog() {
  return get('/api/quotes/accessorials');
}

export function saveQuote(id, name, notes) {
  return post(`/api/quotes/${encodeURIComponent(id)}/save`, { name, ...(notes || {}) });
}

export function listSavedQuotes(user_id) {
  return get('/api/quotes/saved' + (user_id ? `?user_id=${encodeURIComponent(user_id)}` : ''));
}

export function getQuote(id) {
  return get(`/api/quotes/${encodeURIComponent(id)}`);
}

/* Complete a shipment (book label or schedule pickup) + printable BOL. */
export function completeShipment({ shipment_id, rate_id, shipper, consignee, references, delivery_note_1, delivery_note_2, terms_accepted, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup }) {
  return post('/api/shipments/complete', { shipment_id, rate_id, shipper, consignee, references, delivery_note_1, delivery_note_2, terms_accepted, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup });
}

/* Pay-first scheduling: Stripe Checkout for the full freight amount. */
export function checkoutShipment({ shipment_id, rate_id, shipper, consignee, references, delivery_note_1, delivery_note_2, terms_accepted, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup }) {
  return post('/api/shipments/checkout', { shipment_id, rate_id, shipper, consignee, references, delivery_note_1, delivery_note_2, terms_accepted, user_id, region, direction, freight_charges, bill_to, depot_dropoff, depot_pickup });
}

export function getShipmentOrder(id) {
  return get(`/api/shipments/order/${encodeURIComponent(id)}`);
}

export function cancelShipment(id) {
  return post(`/api/shipments/${encodeURIComponent(id)}/cancel`, {});
}

/* Tender queue (admin): paid loads awaiting manual carrier booking. */
export function listTenders() {
  return get('/api/shipments/tenders');
}

export function markTendered(id, carrier_pro) {
  return post(`/api/shipments/tenders/${encodeURIComponent(id)}`, { carrier_pro });
}

/* Dangerous-goods review queue (admin). */
export function listDgQueue() {
  return get('/api/shipments/dg-queue');
}

export function approveDg(id) {
  return post(`/api/shipments/dg-queue/${encodeURIComponent(id)}/approve`, {});
}

export function rejectDg(id) {
  return post(`/api/shipments/dg-queue/${encodeURIComponent(id)}/reject`, {});
}

/* Quote attachments (multipart — auth header, no JSON content type). */
export function listAttachments(quoteId) {
  return get(`/api/quotes/${encodeURIComponent(quoteId)}/attachments`);
}

export function deleteAttachment(quoteId, attId) {
  return request('DELETE', `/api/quotes/${encodeURIComponent(quoteId)}/attachments/${encodeURIComponent(attId)}`);
}

export async function uploadAttachments(quoteId, files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE_URL + `/api/quotes/${encodeURIComponent(quoteId)}/attachments`, {
    method: 'POST', headers, body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Upload failed (${res.status})`);
  return data;
}

export async function downloadAttachment(attId, filename) {
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_BASE_URL + `/api/quotes/attachments/${encodeURIComponent(attId)}/download`, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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

/* Reports — run on screen (JSON) or download as Excel. */
function reportQuery({ start_date, end_date, q, format } = {}) {
  const p = new URLSearchParams();
  if (start_date) p.set('start_date', start_date);
  if (end_date) p.set('end_date', end_date);
  if (q) p.set('q', q);
  if (format) p.set('format', format);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export function getShipmentsReport(opts = {}) {
  return get(`/api/reports/shipments${reportQuery(opts)}`);
}

export function getQuotesReport(opts = {}) {
  return get(`/api/reports/quotes${reportQuery(opts)}`);
}

export function getRevenueReport(opts = {}) {
  return get(`/api/reports/revenue${reportQuery(opts)}`);
}

/* Excel download: same report endpoints with format=xlsx (auth header). */
export async function downloadReport(kind, opts = {}) {
  const token = getAuthToken();
  const res = await fetch(`/api/reports/${kind}${reportQuery({ ...opts, format: 'xlsx' })}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const d = await res.json();
      if (d && d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  const name = m ? m[1] : `apex-${kind}.xlsx`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/* Admin */
export function getAdminOverview() {
  return get('/api/admin/overview');
}

/* Admin — account approvals: new accounts start quote-only until approved. */
export function listUsers() {
  return get('/api/admin/users');
}

export function approveUser(id) {
  return post(`/api/admin/users/${encodeURIComponent(id)}/approve`, {});
}

export function revokeUser(id) {
  return post(`/api/admin/users/${encodeURIComponent(id)}/revoke`, {});
}

/* Admin — per-customer freight markup override. markupPercent is a number
   0–100, or null/'' to reset the account to the global default. */
export function setUserMarkup(id, markupPercent) {
  return post(`/api/admin/users/${encodeURIComponent(id)}/markup`, { markup_percent: markupPercent });
}

/* Address book */
export function listAddresses() {
  return get('/api/address-book');
}

/* Type-ahead over the user's own address book — shown before Google Places. */
export function searchAddresses(q) {
  return get('/api/address-book/search?q=' + encodeURIComponent(q));
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

/* Prime shipping location: one address per account. */
export function getPrimaryAddress() {
  return get('/api/address-book/primary');
}

export function setPrimaryAddress(id) {
  return post(`/api/address-book/${encodeURIComponent(id)}/primary`, {});
}

/* Custom dropdown lists (package types, product names) */
export function listCustomItems(kind) {
  return get(`/api/custom-lists/${encodeURIComponent(kind)}`);
}

export function createCustomItem(kind, label) {
  return post(`/api/custom-lists/${encodeURIComponent(kind)}`, { label });
}

export function deleteCustomItem(kind, id) {
  return request('DELETE', `/api/custom-lists/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
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

/* Northline Ops Bookstore */
export function listStoreProducts() {
  return request('GET', '/api/store/products');
}
export function storeCheckout(slug) {
  return request('POST', '/api/store/checkout', { slug });
}
export function storeLibrary() {
  return request('GET', '/api/store/library');
}
export async function downloadStoreFile(id) {
  const token = getAuthToken();
  const res = await fetch(`/api/store/download/${encodeURIComponent(id)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const d = await res.json();
      if (d && d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  const name = m ? m[1] : 'northline-ops-download';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
export function listStoreOrders() {
  return request('GET', '/api/admin/store/orders');
}
export function listStoreProductsAdmin() {
  return request('GET', '/api/admin/store/products');
}
export function updateStoreProduct(id, patch) {
  return request('PUT', `/api/admin/store/products/${encodeURIComponent(id)}`, patch);
}

/* Northline Ops simple inventory */
export function listInventoryItems() {
  return request('GET', '/api/inventory/items');
}
export function saveInventoryItem(sku, name) {
  return request('POST', '/api/inventory/items', { sku, name });
}
export function scanInventory(sku, direction, qty, name) {
  return request('POST', '/api/inventory/scan', { sku, direction, qty, name });
}
export function listInventoryMovements(limit) {
  return request('GET', '/api/inventory/movements' + (limit ? '?limit=' + limit : ''));
}
