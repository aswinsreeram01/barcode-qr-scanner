/* Reference list: which MRPs are valid for each barcode, imported from a CSV export of
 * the stock database and kept on the device (IndexedDB). */
(function (root) {
  'use strict';

  var DB_NAME = 'scan-audit', STORE = 'kv', KEY = 'reference.v1';

  // EAN-13 "0691027644058", UPC-A "691027644058" and GTIN-14 "00691027644058" are the
  // same product; scanners and databases disagree on the leading zeros.
  function normCode(code) {
    var s = String(code == null ? '' : code).trim();
    if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '');
    return s.toUpperCase();
  }

  // RFC 4180-ish: quoted fields, doubled quotes, delimiter auto-detected from the first line.
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/, 1)[0] || '';
    var delim = [',', ';', '\t'].reduce(function (best, d) {
      return first.split(d).length > first.split(best).length ? d : best;
    }, ',');
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(function (f) { return f.trim() !== ''; })) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(function (f) { return f.trim() !== ''; })) rows.push(row);
    return rows;
  }

  // "3,300" is one price (thousands grouping); "3300 | 3480" or "3300;3480" are two.
  function parseMrps(cell) {
    var s = String(cell == null ? '' : cell).replace(/₹|rs\.?|inr/gi, '').trim();
    if (!s) return [];
    return s.split(/[|;\/]|\s+(?=\d)/).map(function (p) {
      p = p.trim();
      if (/^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(p)) p = p.replace(/,/g, '');
      var v = parseFloat(p);
      return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
    }).filter(function (v) { return v != null; });
  }

  function findCol(header, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      for (var i = 0; i < header.length; i++) if (patterns[p].test(header[i])) return i;
    }
    return -1;
  }

  // CSV text → { items: Map(key → {code, name, mrps[]}), rows, warnings[] }
  function fromCsv(text) {
    var rows = parseCsv(text), warnings = [];
    if (!rows.length) throw new Error('The file is empty.');
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var cCode = findCol(header, [/barcode/, /\bean\b|gtin|upc/, /\bcode\b/]);
    var cMrp = findCol(header, [/m\.?\s*r\.?\s*p/, /price/]);
    var cName = findCol(header, [/product|item\s*name|\bname\b/, /desc/]);
    var body = rows.slice(1);
    if (cCode < 0 || cMrp < 0) {
      // No recognisable header: assume barcode, MRP, name — and keep the first row.
      if (/^\s*\d{6,}\s*$/.test(rows[0][0] || '')) { cCode = 0; cMrp = 1; cName = rows[0].length > 2 ? 2 : -1; body = rows; }
      else throw new Error('Could not find the barcode and MRP columns. Name them "barcode" and "mrp".');
    }

    var items = new Map(), sci = 0, noMrp = 0;
    body.forEach(function (r) {
      var raw = (r[cCode] || '').trim();
      if (!raw) return;
      if (/^\d+(\.\d+)?e\+\d+$/i.test(raw)) { sci++; return; }
      var mrps = parseMrps(r[cMrp]);
      if (!mrps.length) { noMrp++; return; }
      var key = normCode(raw), it = items.get(key);
      if (!it) { it = { code: raw, name: '', mrps: [] }; items.set(key, it); }
      if (!it.name && cName >= 0) it.name = (r[cName] || '').trim();
      mrps.forEach(function (v) { if (it.mrps.indexOf(v) < 0) it.mrps.push(v); });
    });
    items.forEach(function (it) { it.mrps.sort(function (a, b) { return a - b; }); });

    if (sci) warnings.push(sci + ' barcodes look like "6.91E+11" — Excel shortened them. Format the barcode column as Text and export again.');
    if (noMrp) warnings.push(noMrp + ' rows had no MRP and were skipped.');
    if (!items.size) throw new Error('No usable rows found.');
    return { items: items, warnings: warnings };
  }

  /* ---------- persistence ---------- */

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('No IndexedDB')); return; }
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), store = t.objectStore(STORE), out;
        var req = fn(store);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { db.close(); resolve(out); };
        t.onerror = t.onabort = function () { db.close(); reject(t.error); };
      });
    });
  }

  function save(ref) {
    var rows = [];
    ref.items.forEach(function (it, key) { rows.push([key, it.code, it.name, it.mrps]); });
    return tx('readwrite', function (s) {
      return s.put({ name: ref.name, importedAt: ref.importedAt, rows: rows }, KEY);
    });
  }

  function load() {
    return tx('readonly', function (s) { return s.get(KEY); }).then(function (v) {
      if (!v || !Array.isArray(v.rows)) return null;
      var items = new Map();
      v.rows.forEach(function (r) { items.set(r[0], { code: r[1], name: r[2], mrps: r[3] }); });
      return { name: v.name, importedAt: v.importedAt, items: items };
    });
  }

  function clear() { return tx('readwrite', function (s) { return s.delete(KEY); }); }

  function lookup(ref, code) {
    return ref && ref.items ? ref.items.get(normCode(code)) || null : null;
  }

  var api = { normCode: normCode, parseCsv: parseCsv, parseMrps: parseMrps, fromCsv: fromCsv,
              save: save, load: load, clear: clear, lookup: lookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reference = api;
})(typeof self !== 'undefined' ? self : this);
