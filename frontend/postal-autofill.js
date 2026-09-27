/* Postal-code auto-fill for the quote form (offline FSA lookup, no API key).
 *
 * When a postal field holds a Canadian FSA (first 3 chars, e.g. "T5J") that
 * exists in window.APEX_FSA (frontend/fsa.js), the matching city + province
 * fields fill in automatically.
 *
 * - Manual edits are never clobbered: once the user types in city/province
 *   after an auto-fill, those fields stop updating until the postal code
 *   changes to a different FSA.
 * - Unknown FSAs are ignored quietly (no error).
 * - Postal display is normalized to uppercase "A1A 1A1" on blur.
 * - window.APEX_postalFilled(zipName, fsa) is called by the address-book
 *   "Use as shipper/consignee" fill so auto-fill doesn't fight it.
 */
(function () {
  'use strict';

  // Groups of [postal, city, province/state] field names by form block.
  var GROUPS = [
    { zip: 'o_zip', city: 'o_city', state: 'o_state' }, // shipper
    { zip: 'd_zip', city: 'd_city', state: 'd_state' }, // consignee
    { zip: 'b_zip', city: 'b_city', state: 'b_state' }, // third-party billing
    { zip: 'ab_postal', city: 'ab_city', state: 'ab_province' }, // address book form
  ];

  function fsaOf(raw) {
    var c = String(raw == null ? '' : raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    return /^[A-Z]\d[A-Z]/.test(c) ? c.slice(0, 3) : '';
  }

  function normalizePostal(raw) {
    var c = String(raw == null ? '' : raw)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c)) return c.slice(0, 3) + ' ' + c.slice(3);
    return c;
  }

  function el(name) {
    return document.querySelector('[name="' + name + '"]');
  }

  // Called after a programmatic fill (address book): adopt the FSA and treat
  // the filled city/province as user-set so postal auto-fill doesn't fight it.
  function markFilled(zipName, fsa) {
    var g = null;
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].zip === zipName) g = GROUPS[i];
    }
    if (!g) return;
    var z = el(g.zip);
    var c = el(g.city);
    var s = el(g.state);
    if (z) z.dataset.lastFsa = fsa || '';
    if (c) c.dataset.manual = '1';
    if (s) s.dataset.manual = '1';
  }

  function setup() {
    var FSA = (typeof window !== 'undefined' && window.APEX_FSA) || {};
    GROUPS.forEach(function (g) {
      var z = el(g.zip);
      var c = el(g.city);
      var s = el(g.state);
      if (!z) return;

      z.addEventListener('input', function () {
        var fsa = fsaOf(z.value);
        if (fsa === z.dataset.lastFsa) return; // same FSA: never clobber manual edits
        z.dataset.lastFsa = fsa;
        if (c) delete c.dataset.manual;
        if (s) delete s.dataset.manual;
        var hit = fsa && FSA[fsa];
        if (hit) {
          if (c) c.value = hit[0];
          if (s) s.value = hit[1];
        }
        // unknown FSA: quiet, leave city/province alone
      });

      z.addEventListener('blur', function () {
        var n = normalizePostal(z.value);
        if (n !== z.value) z.value = n;
      });

      [c, s].forEach(function (t) {
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
    window.APEX_fsaOf = fsaOf;
    window.APEX_normalizePostal = normalizePostal;
    window.APEX_postalFilled = markFilled;
  }

  // Export for node-based tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fsaOf: fsaOf, normalizePostal: normalizePostal, GROUPS: GROUPS };
  }
})();
