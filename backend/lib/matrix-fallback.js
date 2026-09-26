// lib/matrix-fallback.js — SAMPLE fallback matrix engine.
// Used ONLY when no sibling rates/matrix-engine.js exists (see lib/matrix.js).
// The base rates below are INVENTED SAMPLES for demo/testing — they are NOT
// real carrier tariffs. lib/matrix.js prefers the real engine automatically.
'use strict';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

const state = {
  carriers: [
    { carrier_id: 'hifab', carrier_label: 'HiFab Transport', fsc_percent: 39 },
    { carrier_id: 'guilbault', carrier_label: 'Guilbault Transport', fsc_percent: 41 },
    { carrier_id: 'rosenau', carrier_label: 'Rosenau Transport', fsc_percent: 65.74 },
  ],
  // SAMPLE lanes — invented demo data, not real tariffs.
  lanes: [
    { carrier_id: 'hifab', origin_city: 'ACHESON', origin_prov: 'AB', dest_city: 'CALGARY', dest_prov: 'AB',
      min_charge_cad: 95, breaks: [{ max_lb: 500, rate_cwt: 18.5 }, { max_lb: 1000, rate_cwt: 16.75 }, { max_lb: 2000, rate_cwt: 15.2 }, { max_lb: 999999, rate_cwt: 13.9 }] },
    { carrier_id: 'hifab', origin_city: 'CALGARY', origin_prov: 'AB', dest_city: 'EDMONTON', dest_prov: 'AB',
      min_charge_cad: 95, breaks: [{ max_lb: 500, rate_cwt: 17.9 }, { max_lb: 1000, rate_cwt: 16.1 }, { max_lb: 2000, rate_cwt: 14.7 }, { max_lb: 999999, rate_cwt: 13.4 }] },
    { carrier_id: 'guilbault', origin_city: 'AMARANTH', origin_prov: 'ON', dest_city: 'MONTREAL', dest_prov: 'QC',
      min_charge_cad: 110, breaks: [{ max_lb: 500, rate_cwt: 24.0 }, { max_lb: 1000, rate_cwt: 21.5 }, { max_lb: 2000, rate_cwt: 19.25 }, { max_lb: 999999, rate_cwt: 17.4 }] },
    { carrier_id: 'rosenau', origin_city: 'CALGARY', origin_prov: 'AB', dest_city: 'VANCOUVER', dest_prov: 'BC',
      min_charge_cad: 120, breaks: [{ max_lb: 500, rate_cwt: 28.0 }, { max_lb: 1000, rate_cwt: 25.0 }, { max_lb: 2000, rate_cwt: 22.5 }, { max_lb: 999999, rate_cwt: 20.0 }] },
  ],
  accessorials: [
    { code: 'LIFTGATE', description: 'Liftgate service at pickup or delivery', unit: 'per shipment', amount_cad: 85 },
    { code: 'APPT', description: 'Appointment delivery', unit: 'per shipment', amount_cad: 45 },
    { code: 'RECONSIGN', description: 'Re-consignment / change of consignee', unit: 'per shipment', amount_cad: 60 },
    { code: 'STORAGE', description: 'Storage after free time expires', unit: 'per day', amount_cad: 35 },
  ],
};

const carriersById = () => new Map(state.carriers.map((c) => [c.carrier_id, c]));

function quoteMatrix({ originCity, originProv, destCity, destProv, weightLbs }) {
  const oCity = norm(originCity); const oProv = norm(originProv);
  const dCity = norm(destCity); const dProv = norm(destProv);
  const w = Number(weightLbs);
  if (!oCity || !dCity || !Number.isFinite(w) || w <= 0) return [];
  const byId = carriersById();
  const quotes = [];
  for (const lane of state.lanes) {
    if (lane.origin_city !== oCity || lane.dest_city !== dCity) continue;
    if (oProv && lane.origin_prov && lane.origin_prov !== oProv) continue;
    if (dProv && lane.dest_prov && lane.dest_prov !== dProv) continue;
    const brk = lane.breaks.find((b) => w <= b.max_lb) || lane.breaks[lane.breaks.length - 1];
    if (!brk) continue;
    const carrier = byId.get(lane.carrier_id) || {};
    const raw = (w / 100) * brk.rate_cwt;
    const base = raw < lane.min_charge_cad ? lane.min_charge_cad : raw;
    const fscPercent = Number(carrier.fsc_percent) || 0;
    const fsc = (base * fscPercent) / 100;
    quotes.push({
      carrier_id: lane.carrier_id,
      carrier_label: carrier.carrier_label || lane.carrier_id,
      service: 'LTL',
      weight_lbs: w,
      rate_cwt_used: brk.rate_cwt,
      base_cad: r2(base),
      fsc_percent: fscPercent,
      fsc_cad: r2(fsc),
      total_cad: r2(base + fsc),
      min_charge_applied: raw < lane.min_charge_cad,
      currency: 'CAD',
      source: 'matrix',
    });
  }
  quotes.sort((a, b) => a.total_cad - b.total_cad);
  return quotes;
}

function listCarriers() {
  return state.carriers.map((c) => ({ carrier_id: c.carrier_id, carrier_label: c.carrier_label }));
}

function getAccessorials(carrierId) {
  if (!carriersById().has(carrierId)) return [];
  return state.accessorials;
}

function upsertCarrierRows(carrierId, rows) {
  if (!Array.isArray(rows)) return 0;
  let count = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const lane = {
      carrier_id: carrierId,
      origin_city: norm(r.origin_city),
      origin_prov: norm(r.origin_prov),
      dest_city: norm(r.dest_city),
      dest_prov: norm(r.dest_prov),
      min_charge_cad: Number(r.min_charge_cad) || 0,
      breaks: (Array.isArray(r.breaks) ? r.breaks : [])
        .map((b) => ({ max_lb: Number(b.max_lb), rate_cwt: Number(b.rate_cwt) }))
        .filter((b) => b.max_lb > 0 && b.rate_cwt > 0)
        .sort((a, b) => a.max_lb - b.max_lb),
    };
    if (!lane.origin_city || !lane.dest_city || lane.breaks.length === 0) continue;
    const i = state.lanes.findIndex(
      (l) => l.carrier_id === carrierId && l.origin_city === lane.origin_city &&
             l.origin_prov === lane.origin_prov && l.dest_city === lane.dest_city &&
             l.dest_prov === lane.dest_prov
    );
    if (i >= 0) state.lanes[i] = lane; else state.lanes.push(lane);
    count++;
  }
  return count;
}

module.exports = { quoteMatrix, listCarriers, getAccessorials, upsertCarrierRows };
