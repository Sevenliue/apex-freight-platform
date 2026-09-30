/* Postal-code auto-fill for the quote form (offline FSA lookup, no API key).
 *
 * When a postal field holds a Canadian FSA (first 3 chars, e.g. "T5J") that
 * exists in window.SHIPRATE_FSA (frontend/fsa.js), the matching city + province
 * fields fill in automatically.
 *
 * - Manual edits are never clobbered: a city/province the user typed is left
 *   alone even when the postal code is entered afterward. Empty fields are
 *   auto-filled, and previously auto-filled values update when the FSA changes.
 * - Unknown FSAs are ignored quietly (no error).
 * - Postal display is normalized to uppercase "A1A 1A1" on blur.
 * - window.SHIPRATE_postalFilled(zipName, fsa) is called by the address-book
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
    var FSA = (typeof window !== 'undefined' && window.SHIPRATE_FSA) || {};
    GROUPS.forEach(function (g) {
      var z = el(g.zip);
      var c = el(g.city);
      var s = el(g.state);
      if (!z) return;

      z.addEventListener('input', fillFromPostal);
      // 'change' covers programmatic/automation fills that set the value
      // without firing 'input' (fires on blur after an edit).
      z.addEventListener('change', fillFromPostal);
      function fillFromPostal() {
        var fsa = fsaOf(z.value);
        // Only act on a valid FSA that changed; intermediate keystrokes that
        // briefly make the FSA invalid must not reset the tracking.
        if (!fsa || fsa === z.dataset.lastFsa) return;
        var prev = z.dataset.lastFsa;
        z.dataset.lastFsa = fsa;
        var hit = fsa && FSA[fsa];
        var prevHit = prev && FSA[prev];
        // Fill empty fields; update previously auto-filled ones on FSA change;
        // never overwrite a manually typed value.
        function maybeFill(t, idx) {
          if (!t || !hit) return;
          if (t.dataset.manual) return;
          var cur = t.value.trim();
          if (!cur || (prevHit && cur === prevHit[idx])) t.value = hit[idx];
        }
        maybeFill(c, 0);
        maybeFill(s, 1);
        // unknown FSA: quiet, leave city/province alone
      }

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
    window.SHIPRATE_fsaOf = fsaOf;
    window.SHIPRATE_normalizePostal = normalizePostal;
    window.SHIPRATE_postalFilled = markFilled;
  }

  // Export for node-based tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fsaOf: fsaOf, normalizePostal: normalizePostal, GROUPS: GROUPS };
  }
})();
