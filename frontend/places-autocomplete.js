/* Google Places street-address autocomplete, proxied through /api/places/*.
 * The API key lives server-side only; the browser never sees it.
 *
 * Address-book-first: before asking Google, the signed-in user's own
 * address book is searched (/api/address-book/search). Book matches render
 * at the top of the dropdown (marked ★); Google suggestions follow. This
 * also saves Places API calls on repeat shippers/receivers.
 *
 * Attaches to the street inputs of the quote form address blocks:
 *   shipper   o_street / o_city / o_state / o_zip / o_country (+ s_name, o_phone, o_email)
 *   consignee d_street / d_city / d_state / d_zip / d_country (+ c_name, d_phone, d_email)
 *   3rd party b_street / b_city / b_state / b_zip / b_country (+ b_name)
 *
 * Behavior:
 * - 300ms debounce; keyboard navigation (up/down/enter/escape); click-to-select.
 * - On select of a Google suggestion, GET /api/places/details fills
 *   street/city/province/postal/country.
 * - On select of an address-book entry, every address field (plus contact
 *   name/phone/email where the block has them) fills instantly — no Google call.
 * - Coexists with the offline postal auto-fill: after a suggestion is applied,
 *   window.APEX_postalFilled(zipName, fsa) is called when present so the
 *   postal auto-fill treats those fields as set and doesn't fight it.
 * - When the backend reports { configured: false }, the inputs stay plain
 *   text fields — no errors, no console noise, no visible broken feature.
 */
(function () {
  'use strict';

  var GROUPS = [
    { street: 'o_street', city: 'o_city', state: 'o_state', zip: 'o_zip', country: 'o_country',
      name: 's_name', phone: 'o_phone', email: 'o_email' },
    { street: 'd_street', city: 'd_city', state: 'd_state', zip: 'd_zip', country: 'd_country',
      name: 'c_name', phone: 'd_phone', email: 'd_email' },
    { street: 'b_street', city: 'b_city', state: 'b_state', zip: 'b_zip', country: 'b_country',
      name: 'b_name', phone: null, email: null },
  ];

  var placesOn = null; // null = unknown, false = disabled (no key)
  var openDd = null; // { input, box, items, active }

  function el(name, root) {
    return (root || document).querySelector('[name="' + name + '"]');
  }

  function setVal(name, val) {
    var t = el(name);
    if (t && val) t.value = val;
    return t;
  }

  function closeDropdown() {
    if (openDd && openDd.box && openDd.box.parentNode) openDd.box.parentNode.removeChild(openDd.box);
    openDd = null;
  }

  function positionBox(input, box) {
    var r = input.getBoundingClientRect();
    box.style.position = 'absolute';
    box.style.left = r.left + window.scrollX + 'px';
    box.style.top = r.bottom + window.scrollY + 4 + 'px';
    box.style.width = Math.max(r.width, 280) + 'px';
  }

  function renderDropdown(input, group, items) {
    closeDropdown();
    if (!items.length) return;
    var box = document.createElement('div');
    box.className = 'places-dd';
    items.forEach(function (it, i) {
      var opt = document.createElement('div');
      opt.className = 'opt' + (it.source === 'address_book' ? ' from-book' : '');
      opt.setAttribute('data-i', String(i));
      var main = document.createElement('div');
      main.textContent = it.main_text || it.description;
      opt.appendChild(main);
      if (it.secondary_text) {
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = it.secondary_text;
        opt.appendChild(sub);
      }
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault(); // beat input blur
        selectSuggestion(input, group, it);
      });
      box.appendChild(opt);
    });
    document.body.appendChild(box);
    positionBox(input, box);
    openDd = { input: input, box: box, items: items, active: -1 };
  }

  function setActive(i) {
    if (!openDd) return;
    var n = openDd.items.length;
    openDd.active = ((i % n) + n) % n;
    var opts = openDd.box.querySelectorAll('.opt');
    for (var k = 0; k < opts.length; k++) {
      if (k === openDd.active) opts[k].classList.add('active');
      else opts[k].classList.remove('active');
    }
    if (opts[openDd.active] && opts[openDd.active].scrollIntoView) {
      opts[openDd.active].scrollIntoView({ block: 'nearest' });
    }
  }

  function signedIn() {
    try {
      return !!localStorage.getItem('apex_auth_token');
    } catch (e) {
      return false;
    }
  }

  async function fetchBookSuggestions(q) {
    if (!signedIn()) return [];
    try {
      var r = await fetch('/api/address-book/search?q=' + encodeURIComponent(q));
      var data = await r.json();
      return (data && data.suggestions) || [];
    } catch (e) {
      return []; // address book hiccup: Google path still works
    }
  }

  async function fetchSuggestions(input, group) {
    var q = input.value.trim();
    if (q.length < 3) {
      closeDropdown();
      return;
    }
    // Address book first — the user's own saved shippers/receivers.
    var bookItems = await fetchBookSuggestions(q);
    var country = (el(group.country) && el(group.country).value.trim().toUpperCase()) || 'CA';
    var googleItems = [];
    if (placesOn !== false) {
      try {
        var r = await fetch(
          '/api/places/autocomplete?input=' + encodeURIComponent(q) + '&country=' + encodeURIComponent(country)
        );
        var data = await r.json();
        if (data.configured === false) {
          placesOn = false;
        } else if (!data.error) {
          googleItems = data.suggestions || [];
        }
      } catch (e) {
        /* network hiccup: book results still render */
      }
    }
    renderDropdown(input, group, bookItems.concat(googleItems));
  }

  // Fill the whole address block (and contact fields) from an address-book
  // entry — no Google call needed.
  function applyBookAddress(group, addr) {
    setVal(group.street, addr.street);
    setVal(group.city, addr.city);
    setVal(group.state, addr.province);
    setVal(group.zip, addr.postal);
    setVal(group.country, addr.country);
    if (group.name) setVal(group.name, addr.name);
    if (group.phone) setVal(group.phone, addr.phone);
    if (group.email) setVal(group.email, addr.email);
    var z = el(group.zip);
    var fsa = '';
    if (window.APEX_fsaOf) fsa = window.APEX_fsaOf(addr.postal || '');
    else {
      var c = String(addr.postal || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/^[A-Z]\d[A-Z]/.test(c)) fsa = c.slice(0, 3);
    }
    if (window.APEX_postalFilled) {
      window.APEX_postalFilled(group.zip, fsa);
    } else {
      var cEl = el(group.city);
      var sEl = el(group.state);
      if (z) z.dataset.lastFsa = fsa || '';
      if (cEl) cEl.dataset.manual = '1';
      if (sEl) sEl.dataset.manual = '1';
    }
  }

  async function selectSuggestion(input, group, item) {
    closeDropdown();
    if (item.source === 'address_book' && item.address) {
      input.value = item.address.street || input.value;
      applyBookAddress(group, item.address);
      return;
    }
    input.value = item.main_text || item.description || input.value;
    try {
      var r = await fetch('/api/places/details?place_id=' + encodeURIComponent(item.place_id));
      var data = await r.json();
      if (data.configured === false || data.error) return;
      setVal(group.street, data.street);
      setVal(group.city, data.city);
      setVal(group.state, data.province);
      setVal(group.zip, data.postal);
      setVal(group.country, data.country);
      // Tell postal auto-fill about the fill so it doesn't fight it.
      var fsa = '';
      if (window.APEX_fsaOf) fsa = window.APEX_fsaOf(data.postal || '');
      else {
        var c = String(data.postal || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (/^[A-Z]\d[A-Z]/.test(c)) fsa = c.slice(0, 3);
      }
      if (window.APEX_postalFilled) {
        window.APEX_postalFilled(group.zip, fsa);
      } else {
        // Same flag pattern the postal auto-fill uses, in case it loads later.
        var z = el(group.zip);
        var cEl = el(group.city);
        var sEl = el(group.state);
        if (z) z.dataset.lastFsa = fsa || '';
        if (cEl) cEl.dataset.manual = '1';
        if (sEl) sEl.dataset.manual = '1';
      }
    } catch (e) {
      /* details failed: street text the user saw stays, other fields untouched */
    }
  }

  function attach(input, group) {
    var timer = null;
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () {
      if (placesOn === false) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        fetchSuggestions(input, group);
      }, 300);
    });
    input.addEventListener('keydown', function (e) {
      if (!openDd || openDd.input !== input) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(openDd.active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(openDd.active - 1);
      } else if (e.key === 'Enter') {
        if (openDd.active >= 0) {
          e.preventDefault();
          selectSuggestion(input, group, openDd.items[openDd.active]);
        } else if (openDd.items.length) {
          e.preventDefault();
          selectSuggestion(input, group, openDd.items[0]);
        }
      } else if (e.key === 'Escape') {
        closeDropdown();
      }
    });
    input.addEventListener('blur', function () {
      // mousedown on options fires first (preventDefault), so a short delay is safe
      setTimeout(closeDropdown, 150);
    });
  }

  function setup() {
    var any = false;
    GROUPS.forEach(function (g) {
      var input = el(g.street);
      if (input) {
        attach(input, g);
        any = true;
      }
    });
    if (!any) return;
    document.addEventListener('click', function (e) {
      if (openDd && !openDd.box.contains(e.target) && e.target !== openDd.input) closeDropdown();
    });
    window.addEventListener('resize', closeDropdown);
    window.addEventListener('scroll', closeDropdown, true);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
  }
})();
