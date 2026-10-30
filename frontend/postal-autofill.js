/* Postal-code auto-fill + validate for the quote form (offline, no API key).
 *
 * Typing a postal code fills city + province/state + country automatically:
 * - Canadian codes use the FSA (first 3 chars, e.g. "T5J") in
 *   window.SHIPRATE_FSA (frontend/fsa.js, GeoNames Canada, CC-BY 4.0).
 * - US ZIPs (5 digits, optional +4) use frontend/us-zip.json (GeoNames US,
 *   CC-BY 4.0), fetched on demand the first time a US-looking ZIP is typed,
 *   so the ~1MB file never bloats the initial page load.
 *
 * Rules (same as before, extended):
 * - Manual edits are never clobbered: a city/province/country the user typed
 *   is left alone even when the postal code is entered afterward. Empty
 *   fields are auto-filled, and previously auto-filled values update when
 *   the code changes. Country follows the latest lookup unless typed.
 * - Validation: once a full code is entered (6-char Canadian code, or 5/9
 *   -digit US ZIP) or the field loses focus, an inline note appears when
 *   the code is unknown, or when it belongs to a different city/province
 *   than the one typed. The mismatch note offers "Use <city, prov>" — the
 *   shipper accepts the correction (Freightcom-style), which fills the
 *   fields as auto-filled values. Unknown codes and fetch failures are
 *   otherwise quiet: nothing is overwritten.
 * - Postal display is normalized on blur: "A1A 1A1" for Canada,
 *   "12345-6789" for US ZIP+4.
 * - window.SHIPRATE_postalFilled(zipName, fsa) is called by the address-book
 *   "Use as shipper/consignee" fill so auto-fill doesn't fight it.
 */
(function () {
  'use strict';

  // Groups of [postal, city, province/state, country] field names by block.
  var GROUPS = [
    { zip: 'o_zip', city: 'o_city', state: 'o_state', country: 'o_country' }, // shipper
    { zip: 'd_zip', city: 'd_city', state: 'd_state', country: 'd_country' }, // consignee
    { zip: 'b_zip', city: 'b_city', state: 'b_state', country: 'b_country' }, // third-party billing
    { zip: 'ab_postal', city: 'ab_city', state: 'ab_province', country: 'ab_country' }, // address book form
  ];

  function fsaOf(raw) {
    var c = String(raw == null ? '' : raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    return /^[A-Z]\d[A-Z]/.test(c) ? c.slice(0, 3) : '';
  }

  function zipOf(raw) {
    var c = String(raw == null ? '' : raw).replace(/\D/g, '');
    return /^\d{5}/.test(c) ? c.slice(0, 5) : '';
  }

  // { kind: 'CA', fsa } | { kind: 'US', zip5 } | null (incomplete/ambiguous).
  // A Canadian code never starts with a digit, a US ZIP never starts with a
  // letter, so the first character decides — no ambiguity.
  function parsePostal(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^[A-Za-z]/.test(s)) {
      var fsa = fsaOf(s);
      return fsa ? { kind: 'CA', fsa: fsa } : null;
    }
    if (/^\d/.test(s)) {
      var zip5 = zipOf(s);
      return zip5 ? { kind: 'US', zip5: zip5 } : null;
    }
    return null;
  }

  function normalizePostal(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var digits = s.replace(/\D/g, '');
    if (/^\d{9}$/.test(digits)) return digits.slice(0, 5) + '-' + digits.slice(5);
    if (/^\d{5}$/.test(digits) && !/[A-Za-z]/.test(s)) return digits;
    var c = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c)) return c.slice(0, 3) + ' ' + c.slice(3);
    return s;
  }

  // True once the user has typed a complete code (not mid-typing).
  function isFullCode(raw, parsed) {
    if (!parsed) return false;
    if (parsed.kind === 'CA') return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').length === 6;
    var digits = String(raw).replace(/\D/g, '');
    return digits.length === 5 || digits.length === 9;
  }

  function el(name) {
    return document.querySelector('[name="' + name + '"]');
  }

  // --- US data (lazy, on demand) -------------------------------------------
  var usZipData = null;
  var usZipPromise = null;
  var usZipWaiters = [];

  function usData() {
    if (usZipData) return usZipData;
    if (typeof window !== 'undefined' && window.SHIPRATE_USZIP) {
      usZipData = window.SHIPRATE_USZIP;
      return usZipData;
    }
    return null;
  }

  function ensureUsData(onReady) {
    if (usData()) {
      if (onReady) onReady();
      return;
    }
    if (onReady) usZipWaiters.push(onReady);
    if (usZipPromise) return;
    if (typeof fetch === 'undefined') return;
    usZipPromise = fetch('/us-zip.json')
      .then(function (r) {
        if (!r.ok) throw new Error('us-zip fetch failed');
        return r.json();
      })
      .then(function (json) {
        usZipData = json;
        var waiters = usZipWaiters;
        usZipWaiters = [];
        waiters.forEach(function (fn) {
          try {
            fn();
          } catch (e) {
            /* ignore waiter errors */
          }
        });
      })
      .catch(function () {
        // Lookup unavailable: stay quiet, never overwrite anything.
        usZipPromise = null;
        usZipWaiters = [];
      });
  }

  function fsaData() {
    return (typeof window !== 'undefined' && window.SHIPRATE_FSA) || {};
  }

  // hit: [city, state, country] | null. Key: 'CA:T5J' | 'US:90210'.
  function lookupByKey(key) {
    if (!key) return null;
    var parts = key.split(':');
    if (parts[0] === 'CA') {
      var hit = fsaData()[parts[1]];
      return hit ? [hit[0], hit[1], 'CA'] : null;
    }
    if (parts[0] === 'US') {
      var data = usData();
      var uhit = data && data[parts[1]];
      return uhit ? [uhit[0], uhit[1], 'US'] : null;
    }
    return null;
  }

  function keyOf(parsed) {
    return parsed.kind === 'CA' ? 'CA:' + parsed.fsa : 'US:' + parsed.zip5;
  }

  // Pure validation verdict, for tests and the warning UI:
  // 'ok' | 'unknown' (full code, no hit) | 'mismatch' (hit differs from typed
  // city/state). `typed` marks which fields the user typed by hand.
  function validatePostal(parsed, hit, cityVal, stateVal, typed) {
    if (!parsed || !hit) return 'unknown';
    typed = typed || {};
    if (typed.city && cityVal && cityVal !== hit[0]) return 'mismatch';
    if (typed.state && stateVal && stateVal !== hit[1]) return 'mismatch';
    return 'ok';
  }

  // --- warning UI -----------------------------------------------------------
  function warnEl(g, z) {
    if (g._warn) return g._warn;
    var span = document.createElement('span');
    span.className = 'postal-warn';
    span.style.cssText = 'display:block;color:#b91c1c;font-size:12px;margin-top:2px;';
    if (z.parentNode) z.parentNode.insertBefore(span, z.nextSibling || null);
    g._warn = span;
    return span;
  }

  function clearWarn(g) {
    if (g._warn) {
      g._warn.textContent = '';
      g._warn.style.display = 'none';
    }
  }

  function showWarn(g, z, text, hit, onAccept) {
    var span = warnEl(g, z);
    span.textContent = '';
    span.style.display = 'block';
    span.appendChild(document.createTextNode(text + ' '));
    if (hit && onAccept) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Use ' + hit[0] + ', ' + hit[1];
      btn.style.cssText = 'color:#1d4ed8;text-decoration:underline;background:none;border:none;cursor:pointer;padding:0;font:inherit;';
      btn.addEventListener('click', onAccept);
      span.appendChild(btn);
    }
  }

  // Called after a programmatic fill (address book): adopt the code and treat
  // the filled city/province/country as user-set so auto-fill doesn't fight it.
  function markFilled(zipName, fsa) {
    var g = null;
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].zip === zipName) g = GROUPS[i];
    }
    if (!g) return;
    var z = el(g.zip);
    var c = el(g.city);
    var s = el(g.state);
    var co = el(g.country);
    var parsed = z ? parsePostal(z.value) : null;
    if (z) z.dataset.lastCode = parsed ? keyOf(parsed) : fsa || '';
    if (c) c.dataset.manual = '1';
    if (s) s.dataset.manual = '1';
    if (co) co.dataset.manual = '1';
    clearWarn(g);
  }

  function setup() {
    GROUPS.forEach(function (g) {
      var z = el(g.zip);
      var c = el(g.city);
      var s = el(g.state);
      var co = el(g.country);
      if (!z) return;

      function evaluateWarning() {
        var parsed = parsePostal(z.value);
        if (!parsed) {
          clearWarn(g);
          return;
        }
        if (parsed.kind === 'US' && !usData()) {
          // Not verifiable yet; re-evaluate once the data lands.
          ensureUsData(function () {
            evaluateWarning();
          });
          return;
        }
        var hit = lookupByKey(keyOf(parsed));
        if (!hit) {
          showWarn(g, z, 'Postal code not recognized. Check the code and city/province.');
          return;
        }
        var verdict = validatePostal(
          parsed,
          hit,
          c ? c.value.trim() : '',
          s ? s.value.trim() : '',
          { city: !!(c && c.dataset.manual), state: !!(s && s.dataset.manual) }
        );
        if (verdict === 'mismatch') {
          showWarn(g, z, 'Postal code is for ' + hit[0] + ', ' + hit[1] + '.', hit, function () {
            if (c) {
              c.value = hit[0];
              delete c.dataset.manual;
            }
            if (s) {
              s.value = hit[1];
              delete s.dataset.manual;
            }
            if (co) {
              co.value = hit[2];
              delete co.dataset.manual;
            }
            var p2 = parsePostal(z.value);
            if (p2) z.dataset.prevCode = keyOf(p2);
            clearWarn(g);
          });
        } else {
          clearWarn(g);
        }
      }

      function fillFromPostal() {
        var parsed = parsePostal(z.value);
        if (!parsed) return;
        var codeKey = keyOf(parsed);
        if (codeKey === z.dataset.lastCode) return;
        if (parsed.kind === 'US' && !usData()) {
          // Load the ZIP data, then fill once it lands.
          ensureUsData(function () {
            fillFromPostal();
            evaluateWarning();
          });
          return;
        }
        z.dataset.lastCode = codeKey;
        var prevHit = lookupByKey(z.dataset.prevCode);
        var hit = lookupByKey(codeKey);
        // Fill empty fields; update previously auto-filled ones on code
        // change; never overwrite a manually typed value.
        function maybeFill(t, idx) {
          if (!t || !hit) return;
          if (t.dataset.manual) return;
          var cur = t.value.trim();
          if (!cur || (prevHit && cur === prevHit[idx])) t.value = hit[idx];
        }
        maybeFill(c, 0);
        maybeFill(s, 1);
        // Country follows the latest lookup unless the user typed it.
        if (co && hit && !co.dataset.manual) co.value = hit[2];
        if (hit) z.dataset.prevCode = codeKey;
      }

      z.addEventListener('input', function () {
        fillFromPostal();
        var parsed = parsePostal(z.value);
        if (parsed && isFullCode(z.value, parsed)) evaluateWarning();
      });
      // 'change' covers programmatic/automation fills that set the value
      // without firing 'input' (fires on blur after an edit).
      z.addEventListener('change', fillFromPostal);

      z.addEventListener('blur', function () {
        var n = normalizePostal(z.value);
        if (n !== z.value) z.value = n;
        evaluateWarning();
      });

      [c, s, co].forEach(function (t) {
        if (t)
          t.addEventListener('input', function () {
            t.dataset.manual = '1';
          });
      });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
  }

  if (typeof window !== 'undefined') {
    window.SHIPRATE_fsaOf = fsaOf;
    window.SHIPRATE_zipOf = zipOf;
    window.SHIPRATE_normalizePostal = normalizePostal;
    window.SHIPRATE_postalFilled = markFilled;
  }

  // Export for node-based tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fsaOf: fsaOf,
      zipOf: zipOf,
      normalizePostal: normalizePostal,
      parsePostal: parsePostal,
      isFullCode: isFullCode,
      validatePostal: validatePostal,
      GROUPS: GROUPS,
    };
  }
})();
