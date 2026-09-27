/* api.js — REST wrapper for the Apex Freight & Shipping Canada backend.
   The backend serves these files statically, so the API is on the SAME origin.
   No dependencies. */

const API_BASE_URL = ''; // same origin; set to full URL only if API is hosted separately

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
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
    throw new Error(String(msg));
  }
  return data;
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

/* Health */
export function getHealth() {
  return get('/api/health');
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
