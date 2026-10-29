/* MRP reading rules: pull the MRP off OCR'd label lines and decide whether it can be
 * trusted. Nothing here guesses — a value is only auto-accepted on independent evidence,
 * otherwise the person decides. Shared by the app and the Node tests. */
(function (root) {
  'use strict';

  var MAX_FRAMES = 5;        // OCR attempts before handing over to the person
  var MIN_DIGIT_CONF = 0.9;  // every digit of a repeat-read must be at least this sure

  // "MRP", "M.R.P." and the misreads OCR makes of small print ("MEP", "MRF"), or a
  // combined "MRP/USP" label read too poorly to spell. Not a bare "USP": the first
  // number after that is the per-unit price.
  var LABEL = /M\s*[.,]?\s*[RE]\s*[.,]?\s*[PF]|[A-Z]{2,4}\s*\/\s*USP/i;
  var DATE = /^\d{1,2}\/\d{2,4}$/;
  // "3,300" and "1,23,456" are grouped thousands. OCR often turns the comma into a dot,
  // and paise always have two digits, so "3.300" is 3300 too.
  var PRICE = /\d{1,3}(?:[.,]\d{3})+(?!\d)(?:\.\d{1,2})?|\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/;

  // Inside a number, OCR swaps look-alike letters for digits ("5o0" → 500, "6.9G" → 6.96).
  // Only runs that already contain a digit are touched, and the length never changes, so
  // per-character confidences stay aligned with the text.
  function fixDigits(s) {
    return s.replace(/[0-9OoGSBZIl.]*\d[0-9OoGSBZIl.]*/g, function (run) {
      return run.replace(/[Oo]/g, '0').replace(/G/g, '6').replace(/S/g, '5')
        .replace(/B/g, '8').replace(/Z/g, '2').replace(/[Il]/g, '1');
    });
  }

  function toNumber(s) {
    if (/^\d{1,3}([.,]\d{3})+(\.\d{1,2})?$/.test(s)) {
      var paise = s.match(/(\.\d{1,2})$/);
      return parseFloat(s.slice(0, paise ? -paise[1].length : undefined).replace(/[.,]/g, '') + (paise ? paise[1] : ''));
    }
    return parseFloat(s.replace(/,/g, ''));
  }

  // First price-like token in `text` from `offset`, skipping dates ("09/2027") and unit
  // prices ("2.33/Tab", "per ml") which sit next to the MRP on many labels.
  function firstPrice(text, offset, conf) {
    var re = /\S+/g, m;
    re.lastIndex = offset;
    while ((m = re.exec(text))) {
      var tok = m[0];
      if (DATE.test(tok) || /\/\s*(tab|ml|g|gm|kg|l)\b/i.test(tok) || /per/i.test(tok)) continue;
      var lead = tok.search(/\d/);
      if (lead < 0) continue;
      var num = tok.slice(lead).match(PRICE);
      if (!num) continue;
      var start = m.index + lead;
      return priceAt(num[0], start, conf);
    }
    return null;
  }

  function priceAt(str, start, conf) {
    return { value: toNumber(str), str: str, confs: conf ? conf.slice(start, start + str.length) : null };
  }

  // Lowest confidence over the digits only: whether the separator came out as "," or "."
  // does not change the number, so an unsure separator should not sink the read.
  function digitConf(p, skip) {
    if (!p.confs) return 1;
    var m = 1;
    for (var i = skip || 0; i < p.str.length; i++) {
      if (/\d/.test(p.str[i]) && p.confs[i] != null && p.confs[i] < m) m = p.confs[i];
    }
    return m;
  }

  // The MRP printed on the label, from the line carrying the "MRP" label (or the next
  // line, where the value sits in its own column). Falls back to "3,300/-" amounts.
  function readMrp(lines) {
    for (var i = 0; i < lines.length; i++) {
      var text = fixDigits(lines[i].text), m = text.match(LABEL);
      if (!m) continue;
      var after = m.index + m[0].length;
      var dash = text.indexOf('/-', after);
      var limited = dash > 0 ? text.slice(0, dash) : text;
      var hit = firstPrice(limited, after, lines[i].conf);
      if (!hit && lines[i + 1]) hit = firstPrice(fixDigits(lines[i + 1].text), 0, lines[i + 1].conf);
      if (hit) { hit.line = lines[i].text; return hit; }
    }
    for (i = 0; i < lines.length; i++) {
      text = fixDigits(lines[i].text);
      var d = text.match(/(\d{1,3}(?:[.,]\d{2,3})+|\d{2,6})(?:\.\d{2})?\s*\/\s*-/);
      if (d) {
        var p = priceAt(d[1], d.index, lines[i].conf);
        p.line = lines[i].text;
        return p;
      }
    }
    return null;
  }

  // Unit sale price × net quantity — a second, independent statement of the MRP that
  // Indian labels print alongside it ("USP: ₹4.40 per ml" … "Net Vol: 750ml").
  // The USP unit is often mangled by OCR ("permATaxes"), and it has to be the net
  // quantity's unit anyway, so only a "per 100 g" style count is read from it.
  function readUspCheck(lines) {
    var all = fixDigits(lines.map(function (l) { return l.text; }).join(' '));
    var usp = all.match(/(\d+\.\d{2})\s*(?:per|\/)\s*(\d+)?\s*(ml|gm|tab|kg|g|l)?/i);
    var net = all.match(/Net\s*(?:Vol|Wt|Weight|Content|Qty|Quantity)\s*[:.]?\s*(\d+(?:\.\d+)?)\s*(ml|gm|g|kg|l|tab)/i);
    if (!usp || !net) return null;
    var per = usp[2] ? parseFloat(usp[2]) : 1;
    var u = parseFloat(usp[1]), q = parseFloat(net[1]) / per;
    // USP is printed to the paisa, so the product can be off by up to half a paisa per unit.
    return { usp: u, qty: q, total: u * q, tol: 0.005 * q + 0.01 };
  }

  function uspAgrees(check, v) { return !!check && v != null && Math.abs(check.total - v) <= check.tol; }

  function inList(list, v) {
    if (!list || v == null) return false;
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - v) < 0.005) return true;
    return false;
  }

  // One OCR frame → what it says about the MRP. The ₹ sign is often read as a leading
  // digit ("₹3,300" → "53,300"); the shorter number is only taken when something
  // independent (the reference list or the USP line) names it.
  function assess(lines, allowed) {
    var read = readMrp(lines);
    var check = readUspCheck(lines);
    var r = { found: !!read, read: read ? read.value : null, line: read ? read.line : '', check: check,
              value: null, conf: 0, rupeeFix: false, usp: false };
    if (!read) return r;
    var value = read.value, skip = 0;
    var alt = read.str.length > 1 && /\d/.test(read.str[1]) ? toNumber(read.str.slice(1)) : null;
    if (!inList(allowed, value) && !uspAgrees(check, value) && alt != null &&
        (inList(allowed, alt) || uspAgrees(check, alt))) {
      value = alt; r.rupeeFix = true; skip = 1;   // the first character was the ₹ sign
    }
    r.value = value;
    r.conf = digitConf(read, skip);
    r.usp = uspAgrees(check, value);
    return r;
  }

  function angleGap(a, b) { var d = Math.abs((a || 0) - (b || 0)) % 180; return Math.min(d, 180 - d); }

  // How to straighten the next camera frame, given how the previous ones went
  // (each frame: { found, skew, flip }). An angle that just worked is reused — the
  // pack is held at much the same tilt from frame to frame. Early misses are often just
  // the pack still being turned, so the best angle estimate is trusted until it has
  // failed twice in a row on a steady view; only then try the runner-up angle. A
  // sideways label that shows nothing may simply be upside down: try a half-turn first.
  function nextAttempt(frames) {
    var n = frames.length, last = frames[n - 1], prev = frames[n - 2];
    if (!last) return { avoid: [], flip: false };
    if (last.found) return { avoid: [], prefer: last.skew, flip: !!last.flip };
    if (Math.abs(last.skew || 0) >= 45 && !last.flip) return { avoid: [], flip: true };
    if (prev && !prev.found && !prev.flip && angleGap(prev.skew, last.skew) < 10) return { avoid: [last.skew], flip: false };
    return { avoid: [], flip: false };
  }

  // Two allowed MRPs one digit apart ("3,300" and "3,380") are too easy to confuse —
  // for those, a repeated read is not enough and only the USP line settles it.
  function hasNearSibling(allowed, v) {
    var a = String(Math.round(v * 100));
    return (allowed || []).some(function (o) {
      var b = String(Math.round(o * 100));
      if (b === a || b.length !== a.length) return false;
      var diff = 0;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      return diff === 1;
    });
  }

  /* Combine the frames read so far.
   *   allowed: the reference MRPs for this barcode, or null when the barcode is unknown.
   * Returns { status, value, evidence }:
   *   'verified'  — auto-accept: matches the reference AND has independent support
   *                 (evidence 'ref+usp', 'ref+repeat', or 'usp' when the barcode is unknown)
   *   'pending'   — keep reading
   *   'ask'       — hand over to the person (with the best guess, if any) */
  function decide(frames, allowed) {
    var known = !!(allowed && allowed.length);
    var last = frames[frames.length - 1];

    for (var i = frames.length - 1; i >= 0; i--) {
      var f = frames[i];
      if (f.value == null) continue;
      var match = inList(allowed, f.value);
      // Strongest: the label's own USP line agrees, and the value is in the reference.
      if (f.usp && (match || !known)) {
        return { status: 'verified', value: f.value, evidence: known ? 'ref+usp' : 'usp', inReference: match };
      }
      // Two separate frames reading the same allowed value, every digit confidently.
      if (match && f.conf >= MIN_DIGIT_CONF && !hasNearSibling(allowed, f.value)) {
        for (var j = 0; j < i; j++) {
          var g = frames[j];
          if (g.value === f.value && g.conf >= MIN_DIGIT_CONF) {
            return { status: 'verified', value: f.value, evidence: 'ref+repeat', inReference: true };
          }
        }
      }
    }

    // A label value that is NOT in the reference and is backed by its USP line is a
    // finding, not an OCR slip — but the person still confirms it before it is recorded.
    if (known && last && last.value != null && last.usp && !inList(allowed, last.value)) {
      return { status: 'ask', value: last.value, reason: 'mismatch', inReference: false };
    }
    if (frames.length >= MAX_FRAMES) {
      var guess = bestGuess(frames);
      return { status: 'ask', value: guess, reason: guess == null ? 'unreadable' : 'unconfirmed', inReference: inList(allowed, guess) };
    }
    return { status: 'pending' };
  }

  function bestGuess(frames) {
    var counts = {}, best = null, bestN = 0;
    frames.forEach(function (f) {
      if (f.value == null) return;
      var k = String(f.value);
      counts[k] = (counts[k] || 0) + 1 + (f.usp ? 2 : 0);
      if (counts[k] > bestN) { bestN = counts[k]; best = f.value; }
    });
    return best;
  }

  function format(v) {
    if (v == null) return '';
    var whole = Math.floor(v), paise = Math.round((v - whole) * 100);
    // Indian grouping: 1,23,456
    var s = String(whole), last3 = s.slice(-3), rest = s.slice(0, -3);
    if (rest) last3 = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    return '₹' + last3 + (paise ? '.' + (paise < 10 ? '0' : '') + paise : '');
  }

  var api = {
    readMrp: readMrp, readUspCheck: readUspCheck, assess: assess, decide: decide,
    nextAttempt: nextAttempt, bestGuess: bestGuess, fixDigits: fixDigits, inList: inList, format: format,
    MAX_FRAMES: MAX_FRAMES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mrp = api;
})(typeof self !== 'undefined' ? self : this);
