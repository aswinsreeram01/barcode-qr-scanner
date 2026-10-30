/* On-device text reader: PaddleOCR (PP-OCRv4) models on ONNX Runtime.
 * Pure JS image handling so the same code runs in the browser worker and in Node tests.
 *
 * Pipeline: estimate the text angle from the ink itself → straighten the image →
 * detect text boxes (axis-aligned, since the text is now level) → recognise each box.
 * Straightening first is what lets us skip OpenCV: no rotated boxes to crop. */
(function (root) {
  'use strict';

  var DET_MAX = 960;          // detector input, longest side (multiple of 32)
  var DET_THRESH = 0.3;       // probability that a detector pixel is text
  var BOX_THRESH = 0.5;       // mean probability a box needs to be kept
  var UNCLIP = 1.6;           // grow boxes back out — the detector shrinks text regions
  var REC_HEIGHT = 48;
  var REC_MIN_CONF = 0.5;     // drop lines the recogniser is unsure of

  /* ---------------- image helpers (RGBA, {data, width, height}) ---------------- */

  function makeImage(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  function sample(img, x, y, out, o) {
    // Bilinear; outside the image reads as white so rotation corners stay blank.
    var w = img.width, h = img.height, d = img.data;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    for (var c = 0; c < 3; c++) {
      var v00 = (x0 >= 0 && y0 >= 0 && x0 < w && y0 < h) ? d[(y0 * w + x0) * 4 + c] : 255;
      var v10 = (x0 + 1 >= 0 && y0 >= 0 && x0 + 1 < w && y0 < h) ? d[(y0 * w + x0 + 1) * 4 + c] : 255;
      var v01 = (x0 >= 0 && y0 + 1 >= 0 && x0 < w && y0 + 1 < h) ? d[((y0 + 1) * w + x0) * 4 + c] : 255;
      var v11 = (x0 + 1 >= 0 && y0 + 1 >= 0 && x0 + 1 < w && y0 + 1 < h) ? d[((y0 + 1) * w + x0 + 1) * 4 + c] : 255;
      out[o + c] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    }
    out[o + 3] = 255;
  }

  function resize(img, w, h) {
    var out = makeImage(w, h);
    var sx = img.width / w, sy = img.height / h;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, out.data, (y * w + x) * 4);
      }
    }
    return out;
  }

  function crop(img, x, y, w, h) {
    var out = makeImage(w, h), s = img.data, d = out.data;
    for (var r = 0; r < h; r++) {
      var from = ((y + r) * img.width + x) * 4;
      d.set(s.subarray(from, from + w * 4), r * w * 4);
    }
    return out;
  }

  // Rotate clockwise by `deg` (screen coordinates), growing the canvas to fit.
  function rotate(img, deg) {
    var t = ((deg % 360) + 360) % 360;
    if (t === 0) return img;
    var r = t * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    var w = img.width, h = img.height;
    var W = Math.round(Math.abs(w * c) + Math.abs(h * s));
    var H = Math.round(Math.abs(w * s) + Math.abs(h * c));
    var out = makeImage(W, H);
    var cx = w / 2, cy = h / 2, CX = W / 2, CY = H / 2;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var dx = x - CX, dy = y - CY;
        sample(img, dx * c + dy * s + cx, -dx * s + dy * c + cy, out.data, (y * W + x) * 4);
      }
    }
    return out;
  }

  /* ---------------- angle estimate ---------------- */

  // Text lines are where ink lines up. Project the ink onto each candidate angle and
  // score how peaky the row profile is. Works with or without a barcode in view.
  // Returns the best few distinct angles, best first: a barcode's bars or a busy
  // background can win, so retries move on to the runner-up.
  function skewCandidates(img) {
    var W = Math.min(480, img.width);
    var H = Math.max(1, Math.round(img.height * W / img.width));
    var small = img.width === W ? img : resize(img, W, H);
    var n = W * H, g = new Float32Array(n), d = small.data, i;
    for (i = 0; i < n; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;

    // Contrast stretch between the 1st and 99th percentile.
    var hist = new Uint32Array(256);
    for (i = 0; i < n; i++) hist[g[i] | 0]++;
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
    var span = Math.max(1, hi - lo);
    for (i = 0; i < n; i++) g[i] = Math.min(255, Math.max(0, (g[i] - lo) * 255 / span));

    // Local mean via an integral image: ink is clearly darker than its surroundings,
    // so a dark bottle around a white label does not count as one big blob.
    var R = 10, ii = new Float64Array((W + 1) * (H + 1));
    for (var y = 0; y < H; y++) {
      var row = 0;
      for (var x = 0; x < W; x++) {
        row += g[y * W + x];
        ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1] + row;
      }
    }
    var pts = [];
    for (y = 0; y < H; y++) {
      var y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
      for (x = 0; x < W; x++) {
        var x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
        var sum = ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1] - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
        if (g[y * W + x] < sum / ((x1 - x0) * (y1 - y0)) - 25) pts.push(x - W / 2, y - H / 2);
      }
    }
    if (pts.length < 40) return [0];

    var B = Math.ceil(Math.hypot(W, H)), scores = [];
    var bins = new Float64Array(2 * B + 2);
    for (var a = -90; a < 90; a++) {
      var rr = a * Math.PI / 180, sn = Math.sin(rr), cs = Math.cos(rr);
      bins.fill(0);
      // Split each point between its two nearest bins — plain rounding aliases into a
      // comb at diagonal angles and fakes a sharp profile.
      for (i = 0; i < pts.length; i += 2) {
        var v = -pts[i] * sn + pts[i + 1] * cs + B, b = Math.floor(v), f = v - b;
        bins[b] += 1 - f; bins[b + 1] += f;
      }
      var score = 0;
      for (i = 0; i < bins.length; i++) score += bins[i] * bins[i];
      scores.push(score);
    }
    // Local maxima (the angle axis wraps at ±90), strongest first, at least 15° apart.
    var peaks = [];
    for (i = 0; i < 180; i++) {
      var s0 = scores[i];
      if (s0 >= scores[(i + 179) % 180] && s0 >= scores[(i + 1) % 180]) peaks.push(i);
    }
    peaks.sort(function (p, q) { return scores[q] - scores[p]; });
    var out = [];
    peaks.forEach(function (p) {
      var ang = p - 90;
      var far = out.every(function (o) { var d = Math.abs(o - ang); return Math.min(d, 180 - d) >= 15; });
      if (far && out.length < 3) out.push(ang);
    });
    return out.length ? out : [0];
  }

  function estimateSkew(img) { return skewCandidates(img)[0]; }

  // Angle difference on the ±90° axis, where -89° and 89° are neighbours.
  function gap(a, b) { var d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); }

  /* ---------------- model I/O ---------------- */

  // PaddleOCR models take BGR planes scaled to 0..1.
  function toTensor(ort, img) {
    var w = img.width, h = img.height, n = w * h, d = img.data;
    var t = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      t[i] = d[i * 4 + 2] / 255;
      t[n + i] = d[i * 4 + 1] / 255;
      t[2 * n + i] = d[i * 4] / 255;
    }
    return new ort.Tensor('float32', t, [1, 3, h, w]);
  }

  function detectBoxes(prob, pw, ph) {
    var n = pw * ph, seen = new Uint8Array(n), stack = new Int32Array(n), boxes = [];
    for (var start = 0; start < n; start++) {
      if (seen[start] || prob[start] <= DET_THRESH) continue;
      var top = 0, minX = pw, maxX = 0, minY = ph, maxY = 0, cnt = 0, psum = 0;
      stack[top++] = start; seen[start] = 1;
      while (top) {
        var p = stack[--top], x = p % pw, y = (p - x) / pw;
        cnt++; psum += prob[p];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= ph) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= pw) continue;
            var q = yy * pw + xx;
            if (!seen[q] && prob[q] > DET_THRESH) { seen[q] = 1; stack[top++] = q; }
          }
        }
      }
      var bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (Math.min(bw, bh) < 3 || psum / cnt < BOX_THRESH) continue;
      var grow = bw * bh * UNCLIP / (2 * (bw + bh));
      boxes.push({ x0: minX - grow, y0: minY - grow, x1: maxX + 1 + grow, y1: maxY + 1 + grow });
    }
    return boxes;
  }

  function decode(out, keys) {
    var T = out.dims[1], C = out.dims[2], d = out.data, prev = -1, text = '', conf = [];
    for (var t = 0; t < T; t++) {
      var best = 0, bp = -Infinity;
      for (var k = 0; k < C; k++) { var v = d[t * C + k]; if (v > bp) { bp = v; best = k; } }
      if (best !== 0 && best !== prev) {
        text += best - 1 < keys.length ? keys[best - 1] : ' ';
        conf.push(bp);
      }
      prev = best;
    }
    return { text: text, conf: conf };
  }

  // Boxes on the same row become one line, left to right, joined by a space.
  function groupLines(items) {
    if (!items.length) return [];
    var avgH = items.reduce(function (s, it) { return s + (it.box.y1 - it.box.y0); }, 0) / items.length;
    items.sort(function (a, b) { return (a.box.y0 + a.box.y1) - (b.box.y0 + b.box.y1); });
    var rows = [], cur = null;
    items.forEach(function (it) {
      var mid = (it.box.y0 + it.box.y1) / 2;
      if (cur && Math.abs(mid - cur.mid) < avgH / 2) { cur.items.push(it); }
      else { cur = { mid: mid, items: [it] }; rows.push(cur); }
    });
    return rows.map(function (row) {
      row.items.sort(function (a, b) { return a.box.x0 - b.box.x0; });
      var text = '', conf = [], sum = 0, n = 0;
      row.items.forEach(function (it, i) {
        if (i) { text += ' '; conf.push(1); }
        text += it.text;
        conf = conf.concat(it.conf);
        it.conf.forEach(function (c) { sum += c; n++; });
      });
      return { text: text, conf: conf, mean: n ? sum / n : 0 };
    });
  }

  /* ---------------- engine ---------------- */

  function create(ort, models, sessionOpts) {
    var keys = models.keys.replace(/\r/g, '').split('\n');
    return Promise.all([
      ort.InferenceSession.create(models.det, sessionOpts || {}),
      ort.InferenceSession.create(models.rec, sessionOpts || {})
    ]).then(function (s) {
      var det = s[0], rec = s[1];

      // opts.prefer: an angle that worked on the previous frame — use the candidate
      //   closest to it, if one is within 12°;
      // opts.avoid: angles that already failed — otherwise take the best candidate that
      //   is not within 10° of any of them;
      // opts.flip: turn a further half-turn, for labels the estimate left upside down;
      // opts.enough(lines): called as lines come in, true stops reading the rest.
      function read(img, opts) {
        opts = opts || {};
        var t0 = Date.now();
        var cands = skewCandidates(img), avoid = opts.avoid || [], skew = null;
        if (opts.prefer != null) {
          var near = cands.slice().sort(function (p, q) { return gap(p, opts.prefer) - gap(q, opts.prefer); })[0];
          if (gap(near, opts.prefer) < 12) skew = near;
        }
        if (skew == null) {
          skew = cands.filter(function (c) {
            return avoid.every(function (a) { return gap(c, a) >= 10; });
          })[0];
        }
        if (skew == null) skew = cands[0];
        var turn = -skew + (opts.flip ? 180 : 0);
        var level = rotate(img, turn);
        var t1 = Date.now();

        // Scale up as well as down: small labels need the pixels for the detector.
        var max = opts.detMax || DET_MAX;
        var k = max / Math.max(level.width, level.height);
        var dw = Math.max(32, Math.ceil(level.width * k / 32) * 32);
        var dh = Math.max(32, Math.ceil(level.height * k / 32) * 32);
        var feeds = {};
        feeds[det.inputNames[0]] = toTensor(ort, resize(level, dw, dh));
        return det.run(feeds).then(function (o) {
          var prob = o[det.outputNames[0]].data;
          var rx = level.width / dw, ry = level.height / dh;
          var boxes = detectBoxes(prob, dw, dh).map(function (b) {
            var x0 = Math.max(0, Math.floor(b.x0 * rx)), y0 = Math.max(0, Math.floor(b.y0 * ry));
            var x1 = Math.min(level.width, Math.ceil(b.x1 * rx)), y1 = Math.min(level.height, Math.ceil(b.y1 * ry));
            return { x0: x0, y0: y0, x1: x1, y1: y1 };
          }).filter(function (b) { return b.x1 - b.x0 > 3 && b.y1 - b.y0 > 3; });
          var t2 = Date.now(), items = [], recognised = 0, stopped = false;

          // Recognising takes most of the time, and a label's price lines sit near the
          // bottom, so start there and stop as soon as the caller has what it needs.
          boxes.sort(function (p, q) { return q.y1 - p.y1 || p.x0 - q.x0; });
          var chain = Promise.resolve();
          boxes.forEach(function (b) {
            chain = chain.then(function () {
              if (stopped) return;
              var piece = crop(level, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
              var w = Math.max(16, Math.round(REC_HEIGHT * piece.width / piece.height));
              var f = {};
              f[rec.inputNames[0]] = toTensor(ort, resize(piece, w, REC_HEIGHT));
              return rec.run(f).then(function (r) {
                recognised++;
                var res = decode(r[rec.outputNames[0]], keys);
                if (!res.text) return;
                var mean = res.conf.reduce(function (a, c) { return a + c; }, 0) / res.conf.length;
                if (mean < REC_MIN_CONF) return;
                items.push({ text: res.text, conf: res.conf, box: b });
                if (opts.enough && opts.enough(groupLines(items.slice()))) stopped = true;
              });
            });
          });
          return chain.then(function () {
            return {
              lines: groupLines(items),
              skew: skew,
              candidates: cands,
              turned: turn,
              ms: { straighten: t1 - t0, detect: t2 - t1, recognise: Date.now() - t2, total: Date.now() - t0 },
              boxes: boxes.length,
              recognised: recognised
            };
          });
        });
      }

      return { read: read };
    });
  }

  var api = { create: create, estimateSkew: estimateSkew, skewCandidates: skewCandidates,
              rotate: rotate, resize: resize, crop: crop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OcrCore = api;
})(typeof self !== 'undefined' ? self : this);
