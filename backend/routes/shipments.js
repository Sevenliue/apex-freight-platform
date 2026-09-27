// routes/shipments.js — POST /api/shipments/buy
// Purchases a shipping label for a quoted rate via EasyPost.
// 501 when EASYPOST_API_KEY is not set. Only EasyPost-sourced rates can be
// bought here; matrix rates are carrier-direct LTL quotes, not parcel labels.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const easypost = require('../lib/easypost');
const { store, id } = require('../lib/store');
const { round2 } = require('../lib/money');

const router = express.Router();

router.post('/buy', async (req, res) => {
  const { shipment_id, rate_id, db_quote_id = null, user_id = null, charged_amount } = req.body || {};
  // The logged-in account wins over the optional guest user_id label.
  const effectiveUserId = (req.user && req.user.id) || user_id || null;

  if (!shipment_id || !rate_id) {
    return res.status(400).json({ error: 'shipment_id and rate_id are required' });
  }
  if (!easypost.isEnabled()) {
    return res.status(501).json({ error: 'Label purchase requires EASYPOST_API_KEY' });
  }

  const quote = store.quotes.get(shipment_id);
  if (!quote) {
    return res.status(404).json({ error: 'Unknown shipment_id — request a fresh quote first' });
  }
  const rate = quote.rates.find((r) => r.rate_id === rate_id);
  if (!rate) {
    return res.status(404).json({ error: 'Unknown rate_id for this shipment' });
  }
  if (rate.source !== 'easypost' || !quote.easypost_shipment_id) {
    return res.status(400).json({
      error: 'Only EasyPost rates can be purchased here; matrix rates are carrier-direct quotes',
    });
  }

  try {
    const bought = await easypost.buyLabel(quote.easypost_shipment_id, rate_id);

    const order = {
      id: id('ord'),
      shipment_id,
      rate_id,
      db_quote_id,
      user_id: effectiveUserId,
      carrier: bought.carrier || rate.carrier,
      service: bought.service || rate.service,
      tracking_code: bought.tracking_code,
      label_url: (bought.postage_label && bought.postage_label.label_url) || null,
      status: 'purchased',
      charged_amount: charged_amount != null ? round2(charged_amount) : rate.retail_cad,
      created_at: new Date().toISOString(),
    };
    store.orders.push(order);

    if (db.isEnabled()) {
      try {
        await db.query(
          `INSERT INTO orders (shipment_id, rate_id, user_id, carrier, service, tracking_code, label_url, status, charged_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [order.shipment_id, order.rate_id, order.user_id, order.carrier, order.service,
           order.tracking_code, order.label_url, order.status, order.charged_amount]
        );
      } catch (err) {
        console.error('[shipments/buy] order DB insert failed (non-fatal):', err.message);
      }
    }

    return res.json({
      tracking_code: order.tracking_code,
      carrier: order.carrier,
      service: order.service,
      label_url: order.label_url,
      shipment_id,
      rate_id,
      order_id: order.id,
      status: order.status,
    });
  } catch (err) {
    return res.status(502).json({ error: 'EasyPost label purchase failed', detail: err.message });
  }
});

module.exports = router;

// ---------------------------------------------------------------------------
// POST /api/shipments/complete — "Complete This Shipment".
// Body: shipment_id (quote id from POST /api/rates), rate_id, plus
//   shipper {}, consignee {}, references {}, delivery_notes, user_id.
//
// - Live (EasyPost) rate + key configured → buys the label via EasyPost.
// - Matrix rate (or no EasyPost key) → records the shipment as "scheduled"
//   with the chosen rate-sheet carrier and an internal PRO reference.
// Always persists to the orders table when a database is configured.
// ---------------------------------------------------------------------------
const easypostRoute = require('./easypost');

router.post('/complete', async (req, res) => {
  const {
    shipment_id, rate_id,
    shipper = {}, consignee = {}, references = {},
    delivery_note_1 = null, delivery_note_2 = null, delivery_notes = '',
    user_id = null,
    region = null, direction = null, freight_charges = null, bill_to = null,
    depot_dropoff = null, depot_pickup = null,
  } = req.body || {};

  // The logged-in account wins over the optional guest user_id label.
  const effectiveUserId = (req.user && req.user.id) || user_id || null;

  if (!shipment_id || !rate_id) {
    return res.status(400).json({ error: 'shipment_id and rate_id are required' });
  }
  const quote = store.quotes.get(shipment_id);
  if (!quote) {
    return res.status(404).json({ error: 'Unknown shipment_id — request a fresh quote first' });
  }
  const rate = (quote.rates || []).find((r) => r.rate_id === rate_id);
  if (!rate) {
    return res.status(404).json({ error: 'Unknown rate_id for this shipment' });
  }

  // Shipment type + freight charges: prefer the completion payload, fall back
  // to what was stored on the quote.
  const shipRegion = region || quote.region || 'canada_usa';
  const shipDirection = direction || quote.direction || 'outbound';
  const shipFreight = freight_charges || quote.freight_charges || 'prepaid';
  const shipBillTo = bill_to || quote.bill_to || {};
  // Depot flags: prefer the completion payload, fall back to the quote.
  const shipDepotDropoff = depot_dropoff != null ? !!depot_dropoff : !!quote.depot_dropoff;
  const shipDepotPickup = depot_pickup != null ? !!depot_pickup : !!quote.depot_pickup;
  // Delivery notes: prefer the completion payload, fall back to the quote
  // (legacy single delivery_notes maps to Box 1).
  const pickNote = (v, fb) => (v === undefined || v === null) ? String(fb || '') : String(v).slice(0, 60);
  const shipNote1 = pickNote(delivery_note_1, quote.delivery_note_1 || delivery_notes);
  const shipNote2 = pickNote(delivery_note_2, quote.delivery_note_2);

  const order = {
    id: id('ord'),
    quote_id: quote.db_quote_id || null,
    shipment_id,
    rate_id,
    user_id: effectiveUserId,
    carrier: rate.carrier,
    service: rate.service,
    cost_cad: rate.cost_cad,
    charged_amount: rate.retail_cad,
    currency: rate.currency || 'CAD',
    status: 'scheduled',
    tracking_code: null,
    label_url: null,
    easypost_shipment_id: quote.easypost_shipment_id || null,
    region: shipRegion,
    direction: shipDirection,
    freight_charges: shipFreight,
    bill_to: shipBillTo,
    created_at: new Date().toISOString(),
  };

  // Live rate + EasyPost connected → buy the label for real.
  if (rate.source === 'easypost' && quote.easypost_shipment_id && easypost.isEnabled()) {
    try {
      const bought = await easypostRoute.buyEasypostLabel(quote.easypost_shipment_id, rate_id);
      order.status = 'purchased';
      order.tracking_code = bought.tracking_code || null;
      order.label_url = (bought.postage_label && bought.postage_label.label_url) || null;
      order.carrier = bought.carrier || rate.carrier;
      order.service = bought.service || rate.service;
    } catch (err) {
      return res.status(502).json({ error: 'Label purchase failed', detail: err.message });
    }
  } else {
    // Matrix rate-sheet carrier: schedule the shipment, mint an internal PRO.
    order.tracking_code = 'APX-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  const bol = {
    shipper, consignee, references, delivery_note_1: shipNote1, delivery_note_2: shipNote2,
    packages: quote.packages || [],
    total_weight_lbs: quote.total_weight_lbs ?? null,
    accessorials_applied: rate.accessorials_applied || [],
    accessorial_total_cad: rate.accessorial_total_cad || 0,
    carrier: order.carrier,
    service: order.service,
    delivery_days: rate.delivery_days || null,
    cost_cad: order.cost_cad,
    charged_amount: order.charged_amount,
    region: shipRegion,
    direction: shipDirection,
    freight_charges: shipFreight,
    bill_to: shipBillTo,
    depot_dropoff: shipDepotDropoff,
    depot_pickup: shipDepotPickup,
    insurance_declared_value: rate.insurance_declared_value || null,
    insurance_cad: rate.insurance_cad || null,
  };
  order.bol = bol;

  store.orders.push(order);

  if (db.isEnabled()) {
    try {
      const userUuid = effectiveUserId ? await db.ensureUser(effectiveUserId, 'shipper') : null;
      await db.query(
        `INSERT INTO orders (quote_id, user_id, easypost_shipment_id, easypost_rate_id,
                             tracking_code, carrier, service_level, cost_amount,
                             charged_amount, currency, label_url, status, bol_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [order.quote_id, userUuid, order.easypost_shipment_id, rate.source === 'easypost' ? rate_id : null,
         order.tracking_code, order.carrier, order.service, order.cost_cad,
         order.charged_amount, order.currency, order.label_url, order.status,
         JSON.stringify(bol)]
      );
    } catch (err) {
      console.error('[shipments/complete] order DB insert failed (non-fatal):', err.message);
    }
  }

  return res.json({
    order_id: order.id,
    status: order.status,
    carrier: order.carrier,
    service: order.service,
    tracking_code: order.tracking_code,
    label_url: order.label_url,
    charged_amount: order.charged_amount,
    bol_url: `/api/shipments/bol/${encodeURIComponent(order.id)}`,
  });
});

// ---------------------------------------------------------------------------
// GET /api/shipments/bol/:id — printable bill of lading for a completed
// shipment. Self-contained HTML with a Print button.
// ---------------------------------------------------------------------------
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cadFmt = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function findOrder(id) {
  const mem = store.orders.find((o) => o.id === id);
  if (mem) return { ...mem, bol: mem.bol || {} };
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      let bol = {};
      try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
      return {
        id: row.id, status: row.status, carrier: row.carrier, service: row.service_level,
        tracking_code: row.tracking_code, label_url: row.label_url,
        cost_cad: row.cost_amount != null ? Number(row.cost_amount) : null,
        charged_amount: row.charged_amount != null ? Number(row.charged_amount) : null,
        created_at: row.created_at, bol,
      };
    } catch { return null; }
  }
  return null;
}

router.get('/bol/:id', async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).send('Shipment not found');
  const b = order.bol || {};
  const shipper = b.shipper || {};
  const consignee = b.consignee || {};
  const refs = b.references || {};
  const addr = (p) =>
    [p.street1 || p.street, [p.city, p.state || p.province].filter(Boolean).join(', '), p.zip || p.postal, p.country]
      .filter(Boolean).join('<br>');
  const pkgRows = (b.packages || [])
    .map(
      (p) => `<tr><td>${p.qty}</td><td>${escHtml(p.package_type)}</td><td>${escHtml(p.product_name)}</td>
        <td class="num">${p.weight_lb}</td><td class="num">${p.length ?? '—'}</td>
        <td class="num">${p.width ?? '—'}</td><td class="num">${p.height ?? '—'}</td>
        <td>${p.stackable ? 'Yes' : 'No'}</td><td>${p.dg ? 'Yes' : 'No'}</td></tr>`
    )
    .join('');
  const accRows = (b.accessorials_applied || [])
    .map((a) => `<tr><td>${escHtml(a.label)}</td><td class="num">${cadFmt(a.fee_cad)}</td></tr>`)
    .join('');
  const refRows = Object.entries(refs)
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`)
    .join('');

  // Freight Charges / Bill To: who pays, and the address to bill.
  const FREIGHT_LABELS = {
    prepaid: 'Prepaid — bill shipper',
    collect: 'Collect — bill consignee',
    third_party: 'Third party — bill 3rd party',
  };
  const fc = b.freight_charges || 'prepaid';
  const fcLabel = FREIGHT_LABELS[fc] || fc;
  const payer = fc === 'collect' ? consignee : fc === 'third_party' ? (b.bill_to || {}) : shipper;
  const payerAddr = addr(payer);
  const payerName = payer.name ? `<strong>${escHtml(payer.name)}</strong><br>` : '';

  // Depot service options (competitor parity).
  const depotRows = [
    b.depot_dropoff ? '<tr><td>Pick-up</td><td><strong>Drop off at depot — do not dispatch</strong></td></tr>' : '',
    b.depot_pickup ? '<tr><td>Delivery</td><td><strong>Pick up at depot — no carrier delivery</strong></td></tr>' : '',
  ].join('');

  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Bill of Lading — ${escHtml(order.tracking_code || order.id)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:32px;color:#111}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px;border-bottom:2px solid #111;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #999;padding:6px 8px;text-align:left}
th{background:#eee}.num{text-align:right}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.box{border:1px solid #999;padding:10px;font-size:13px;line-height:1.5}
.sig{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:32px;font-size:13px}
.sig div{border-top:1px solid #111;padding-top:6px}
.note{font-size:12px;color:#555;margin-top:12px}
@media print{.noprint{display:none}}
</style></head><body>
<div class="noprint" style="margin-bottom:16px"><button onclick="window.print()">Print</button></div>
<h1>Bill of Lading</h1>
<p>PRO / Reference: <strong>${escHtml(order.tracking_code || order.id)}</strong> &nbsp;·&nbsp;
Status: <strong>${escHtml(order.status)}</strong> &nbsp;·&nbsp;
Date: ${escHtml(order.created_at ? new Date(order.created_at).toLocaleDateString('en-CA') : '')}</p>
<div class="grid">
<div><h2>Shipper</h2><div class="box"><strong>${escHtml(shipper.name)}</strong><br>${addr(shipper)}
${shipper.phone ? '<br>Tel: ' + escHtml(shipper.phone) : ''}${shipper.email ? '<br>' + escHtml(shipper.email) : ''}</div></div>
<div><h2>Consignee</h2><div class="box"><strong>${escHtml(consignee.name)}</strong><br>${addr(consignee)}
${consignee.phone ? '<br>Tel: ' + escHtml(consignee.phone) : ''}${consignee.email ? '<br>' + escHtml(consignee.email) : ''}</div></div>
</div>
<h2>Packages</h2>
<table><thead><tr><th>Qty</th><th>Type</th><th>Product</th><th>Weight (lb)</th><th>L (in)</th><th>W (in)</th><th>H (in)</th><th>Stackable</th><th>DG</th></tr></thead>
<tbody>${pkgRows || '<tr><td colspan="9">—</td></tr>'}</tbody></table>
<p>Total weight: <strong>${b.total_weight_lbs ?? '—'} lb</strong></p>
<h2>Carrier &amp; Charges</h2>
<table><tbody>
<tr><td>Carrier</td><td><strong>${escHtml(order.carrier)}${order.service ? ' — ' + escHtml(order.service) : ''}</strong></td></tr>
<tr><td>Estimated transit</td><td>${escHtml(b.delivery_days || '—')} (not guaranteed)</td></tr>
<tr><td>Freight cost</td><td class="num">${cadFmt(b.cost_cad != null && b.accessorial_total_cad ? Number(b.cost_cad) - Number(b.accessorial_total_cad) : b.cost_cad)}</td></tr>
${accRows}
${b.insurance_cad ? `<tr><td>Additional insurance (declared value ${cadFmt(b.insurance_declared_value)})</td><td class="num">${cadFmt(b.insurance_cad)}</td></tr>` : ''}
<tr><td><strong>Total (excl. tax)</strong></td><td class="num"><strong>${cadFmt(order.charged_amount)}</strong></td></tr>
</tbody></table>
<h2>Freight Charges / Bill To</h2>
<div class="box">${escHtml(fcLabel)}<br>${payerName}${payerAddr || '—'}
${payer.phone ? '<br>Tel: ' + escHtml(payer.phone) : ''}${payer.email ? '<br>' + escHtml(payer.email) : ''}</div>
${refRows ? `<h2>References</h2><table><tbody>${refRows}</tbody></table>` : ''}
${depotRows ? `<h2>Service Options</h2><table><tbody>${depotRows}</tbody></table>` : ''}
${(() => { const n = [b.delivery_note_1, b.delivery_note_2].filter(Boolean).map(escHtml).join('<br>'); return n ? `<h2>Delivery Notes</h2><div class="box">${n}</div>` : ''; })()}
<div class="sig"><div>Shipper signature / date</div><div>Carrier signature / date</div></div>
<p class="note">Generated by Apex Freight &amp; Shipping Canada. Transit times are estimates, not guaranteed.</p>
</body></html>`);
});
module.exports = router;
