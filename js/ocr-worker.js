/* Runs the MRP text reader off the main thread so the camera preview never stalls.
 * Models are kept in Cache Storage after the first download, so later visits — and
 * offline use — skip the ~27 MB fetch. */
/* global ort, OcrCore */
'use strict';

importScripts('../vendor/onnxruntime-web/ort.wasm.min.js', 'ocr-core.js');

var MODEL_CACHE = 'mrp-models-v1';
var base = new URL('../vendor/', self.location.href).href;

ort.env.wasm.wasmPaths = base + 'onnxruntime-web/';
// Multi-threading needs cross-origin isolation, which static hosting such as GitHub
// Pages does not provide.
ort.env.wasm.numThreads = 1;

function fetchCached(url, as) {
  var hit = self.caches ? caches.open(MODEL_CACHE).then(function (c) {
    return c.match(url).then(function (r) {
      if (r) return r;
      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error('Could not download ' + url.split('/').pop());
        return c.put(url, res.clone()).catch(function () {}).then(function () { return res; });
      });
    });
  }) : fetch(url);
  return hit.then(function (r) { return as === 'text' ? r.text() : r.arrayBuffer(); });
}

var engine = null;
var ready = Promise.all([
  fetchCached(base + 'paddleocr/det.onnx'),
  fetchCached(base + 'paddleocr/rec.onnx'),
  fetchCached(base + 'paddleocr/keys.txt', 'text')
]).then(function (m) {
  return OcrCore.create(ort, { det: new Uint8Array(m[0]), rec: new Uint8Array(m[1]), keys: m[2] },
    { executionProviders: ['wasm'] });
}).then(function (e) { engine = e; });

var t0 = Date.now();
ready.then(function () {
  self.postMessage({ type: 'ready', ms: Date.now() - t0 });
}, function (err) {
  self.postMessage({ type: 'error', message: String(err && err.message || err) });
});

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== 'read') return;
  ready.then(function () {
    var img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
    return engine.read(img, msg.opts || {});
  }).then(function (res) {
    self.postMessage({ type: 'result', id: msg.id, lines: res.lines, skew: res.skew, ms: res.ms });
  }, function (err) {
    self.postMessage({ type: 'result', id: msg.id, error: String(err && err.message || err) });
  });
};
