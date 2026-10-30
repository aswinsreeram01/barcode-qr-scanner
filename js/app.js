/* Barcode & QR scanner — rapid multi-scan, fully client-side.
 * Decoding: native BarcodeDetector on Android (ML Kit-backed), the zxing-cpp
 * WebAssembly port everywhere else, with the old JS port as a last resort.
 * Audit mode counts units per barcode + price, reading the price on the device
 * (js/ocr-worker.js, rules in js/mrp.js) and exporting to Excel (js/xlsx.js). */
/* global Mrp, Xlsx */
(function () {
  'use strict';

  var SCAN_INTERVAL_MS = 40;    // breathing room between decode attempts
  var MAX_EDGE = 1280;          // downscale the cropped region to this before decoding
  var REGION_PAD = 0.15;        // decode a slightly larger area than the visible frame
  var READER_OPTS = { tryHarder: true, maxNumberOfSymbols: 1 };
  var DEFAULT_ZOOM = 2;         // sensor-crop zoom: lets you scan from where focus works
  var BACKUP_AFTER_MS = 3000;   // native engine dry spell before the wasm backup joins in
  var ZOOM_KEY = 'scan.zoom.v1';
  var DUPE_WINDOW_MS = 1800;    // ignore the same value re-read within this window
  var RESUME_COOLDOWN_MS = 1200;// after keep/discard, suppress the same code this long
  var AUTO_CONFIRM_MS = 1100;   // how long the confirmation card stays up in rapid mode
  var MAX_HISTORY = 200;
  var HISTORY_KEY = 'scan.history.v1';
  var MODE_KEY = 'scan.mode.v1';
  var AUDIT_KEY = 'scan.audit.v2';
  var OCR_MAX_EDGE = 1280;      // label crop handed to the text reader
  var OCR_PAD = 0.12;           // read a margin round the frame: USP lines sit at label edges
  var COUNTED_MS = 3000;        // how long Edit / Undo stay up after a unit is counted
  var NO_BARCODE_HINT_MS = 8000;// no barcode for this long: tell the person how to help
  var DUPE_HINT_MS = 2500;

  function $(id) { return document.getElementById(id); }

  var el = {
    stage: $('stage'), video: $('video'), frame: $('frame'), flash: $('flash'),
    notice: $('notice'), engineBadge: $('engineBadge'),
    sessionChip: $('sessionChip'), sessionCount: $('sessionCount'),
    armed: $('armed'),
    zoomWrap: $('zoomWrap'), zoomSlider: $('zoomSlider'), zoomLabel: $('zoomLabel'),
    focusRing: $('focusRing'),
    confirm: $('confirm'), confirmCard: $('confirmCard'), confirmFormat: $('confirmFormat'),
    confirmIndex: $('confirmIndex'), confirmValue: $('confirmValue'),
    confirmActions: $('confirmActions'), keepBtn: $('keepBtn'), discardBtn: $('discardBtn'),
    startBtn: $('startBtn'), startLabel: $('startBtnLabel'),
    torchBtn: $('torchBtn'), flipBtn: $('flipBtn'),
    modeAuto: $('modeAuto'), modeConfirm: $('modeConfirm'), modeAudit: $('modeAudit'),
    history: $('history'), historyCount: $('historyCount'),
    historyEmpty: $('historyEmpty'), clearBtn: $('clearBtn'), exportBtn: $('exportBtn'),
    scanSection: $('scanSection'), auditSection: $('auditSection'),
    audit: $('audit'), auditCard: $('auditCard'), auditStep: $('auditStep'),
    auditCancel: $('auditCancel'), auditCode: $('auditCode'), auditStatus: $('auditStatus'),
    auditOther: $('auditOther'), auditOtherInput: $('auditOtherInput'), auditActions: $('auditActions'),
    auditTitle: $('auditTitle'), auditSub: $('auditSub'), auditEndBtn: $('auditEndBtn'),
    auditDownloadBtn: $('auditDownloadBtn'), ocrState: $('ocrState'),
    auditUnits: $('auditUnits'), auditList: $('auditList'), auditEmpty: $('auditEmpty')
  };

  var state = {
    running: false, starting: false, paused: false,
    stream: null, track: null,
    engine: null, detector: null, wasm: null, wasmLoading: null,
    zxing: null, zxingHints: null,
    lastHitAt: 0, backupN: 0, zoomTarget: 0, zoomBusy: false,
    deviceIds: [], deviceIndex: 0,
    torchOn: false,
    mode: 'auto',
    sessionCount: 0,
    pending: null,
    lastValue: '', lastAt: 0,
    timer: null, confirmTimer: null,
    history: [],
    // session: the audit (see "audit: session"); audit: the product in hand
    session: null, audit: { step: 'barcode' }, auditTimer: null, rowEdit: null,
    armedAt: 0, dupeAt: 0, dupeTimer: null,
    ocr: { worker: null, ready: false, error: '', seq: 0, waiting: {} }
  };

  var isAndroid = /android/i.test(navigator.userAgent || '');

  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var ocrCanvas = document.createElement('canvas');
  var ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });
  var audioCtx = null;

  var FORMAT_NAMES = {
    QR_CODE: 'QR Code', QRCODE: 'QR Code', MICROQRCODE: 'Micro QR', RMQRCODE: 'rMQR',
    DATA_MATRIX: 'Data Matrix', DATAMATRIX: 'Data Matrix',
    PDF_417: 'PDF417', PDF417: 'PDF417', AZTEC: 'Aztec', CODABAR: 'Codabar',
    CODE_39: 'Code 39', CODE39: 'Code 39', CODE_93: 'Code 93', CODE93: 'Code 93',
    CODE_128: 'Code 128', CODE128: 'Code 128',
    EAN_8: 'EAN-8', 'EAN-8': 'EAN-8', EAN_13: 'EAN-13', 'EAN-13': 'EAN-13',
    ITF: 'ITF', UPC_A: 'UPC-A', 'UPC-A': 'UPC-A', UPC_E: 'UPC-E', 'UPC-E': 'UPC-E',
    RSS_14: 'DataBar', DATABAR: 'DataBar', RSS_EXPANDED: 'DataBar Expanded',
    DATABAREXPANDED: 'DataBar Expanded', DATABARLIMITED: 'DataBar Limited',
    MAXICODE: 'MaxiCode', UPC_EAN_EXTENSION: 'UPC/EAN Ext', DXFILMEDGE: 'DX Film Edge',
    UNKNOWN: 'Code'
  };

  function prettyFormat(raw) {
    var key = String(raw == null ? '' : raw).toUpperCase();
    return FORMAT_NAMES[key] || (key ? key.replace(/_/g, ' ') : 'Code');
  }

  function setNotice(msg, kind) {
    if (!msg) { el.notice.hidden = true; el.notice.textContent = ''; return; }
    el.notice.className = 'notice' + (kind ? ' ' + kind : '');
    el.notice.textContent = msg;
    el.notice.hidden = false;
  }

  function timeLabel(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }

  /* ---------------- engine ---------------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadWasm() {
    if (state.wasm) return Promise.resolve(state.wasm);
    if (state.wasmLoading) return state.wasmLoading;
    state.wasmLoading = loadScript('vendor/zxing-wasm/index.js').then(function () {
      var W = window.ZXingWASM;
      W.prepareZXingModule({
        overrides: {
          locateFile: function (path, prefix) {
            return /\.wasm$/.test(path) ? 'vendor/zxing-wasm/' + path : prefix + path;
          }
        }
      });
      // Decode a dummy image up front so wasm fetch+compile doesn't eat the first scan.
      return W.readBarcodes(ctx.createImageData(8, 8), READER_OPTS).then(function () {
        state.wasm = W;
        return W;
      });
    });
    state.wasmLoading.catch(function () { state.wasmLoading = null; });
    return state.wasmLoading;
  }

  function setupEngine() {
    if (state.engine) return Promise.resolve();

    // Android's BarcodeDetector is ML Kit-backed — fast and accurate. Desktop and
    // iOS builds are missing or unreliable, so everything else gets the wasm decoder.
    var native = Promise.resolve(null);
    if (isAndroid && 'BarcodeDetector' in window && window.BarcodeDetector.getSupportedFormats) {
      native = window.BarcodeDetector.getSupportedFormats().catch(function () { return null; });
    }

    return native.then(function (formats) {
      if (formats && formats.length) {
        try {
          state.detector = new window.BarcodeDetector({ formats: formats });
          state.engine = 'native';
          el.engineBadge.textContent = 'Native';
          el.engineBadge.title = 'Built-in BarcodeDetector (' + formats.length + ' formats)';
          return;
        } catch (e) { /* fall through to wasm */ }
      }
      return loadWasm().then(function () {
        state.engine = 'wasm';
        el.engineBadge.textContent = 'WASM';
        el.engineBadge.title = 'zxing-cpp WebAssembly decoder';
      }).catch(function () {
        // Last resort: the old JS port of ZXing.
        return loadScript('vendor/zxing.min.js').then(function () {
          var Z = window.ZXing;
          var hints = new Map();
          hints.set(Z.DecodeHintType.TRY_HARDER, true);
          var reader = new Z.MultiFormatReader();
          reader.setHints(hints);
          state.zxing = reader;
          state.zxingHints = hints;
          state.engine = 'zxing-js';
          el.engineBadge.textContent = 'ZXing JS';
          el.engineBadge.title = 'Legacy JS decoder';
        });
      });
    });
  }

  /* ---------------- camera ---------------- */

  function closeStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    state.stream = null;
    state.track = null;
    try { el.video.srcObject = null; } catch (e) {}
  }

  function baseConstraints() {
    var v = { width: { ideal: 2560 }, height: { ideal: 1440 } };
    if (state.deviceIds.length) {
      v.deviceId = { exact: state.deviceIds[state.deviceIndex] };
    } else {
      v.facingMode = { ideal: 'environment' };
    }
    return { video: v, audio: false };
  }

  function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      var cams = list.filter(function (d) { return d.kind === 'videoinput' && d.deviceId; });
      state.deviceIds = cams.map(function (d) { return d.deviceId; });
      var current = null;
      try { current = state.track && state.track.getSettings ? state.track.getSettings().deviceId : null; } catch (e) {}
      if (current) {
        var i = state.deviceIds.indexOf(current);
        if (i >= 0) state.deviceIndex = i;
      }
      if (state.deviceIndex >= state.deviceIds.length) state.deviceIndex = 0;
      el.flipBtn.disabled = state.deviceIds.length < 2;
    }).catch(function () {});
  }

  // Resolves once the video has real dimensions, but never hangs: some streams
  // never fire canplay (e.g. a source that has not produced a frame yet).
  function waitForVideo(timeoutMs) {
    var v = el.video;
    if (v.readyState >= 2 && v.videoWidth) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        v.removeEventListener('loadedmetadata', finish);
        v.removeEventListener('canplay', finish);
        resolve();
      }
      var timer = window.setTimeout(finish, timeoutMs);
      v.addEventListener('loadedmetadata', finish);
      v.addEventListener('canplay', finish);
    });
  }

  function openStream() {
    closeStream();
    return navigator.mediaDevices.getUserMedia(baseConstraints()).then(function (stream) {
      state.stream = stream;
      state.track = stream.getVideoTracks()[0] || null;
      el.video.srcObject = stream;
      var p = el.video.play();
      if (p && p.catch) p.catch(function () {});   // deliberately not awaited
      return waitForVideo(4000);
    }).then(improveTrack).then(setupZoom).then(refreshDevices).then(updateTorchButton);
  }

  // Blurry close-ups are the main cause of missed 1D reads — ask the camera to
  // keep refocusing rather than lock focus at whatever distance it opened with.
  function improveTrack() {
    var t = state.track;
    if (!t || !t.getCapabilities || !t.applyConstraints) return;
    var caps = null;
    try { caps = t.getCapabilities(); } catch (e) {}
    if (!caps || !Array.isArray(caps.focusMode) || caps.focusMode.indexOf('continuous') < 0) return;
    return t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
  }

  // Phone cameras usually cannot focus close enough for a barcode to fill the
  // frame. Sensor-crop zoom is the fix scanning apps use: scan from 20-30cm out,
  // where autofocus works, and let zoom supply the magnification.
  function setupZoom() {
    var t = state.track, caps = null;
    try { caps = t && t.getCapabilities ? t.getCapabilities() : null; } catch (e) {}
    var z = caps && caps.zoom;
    if (!z || !(z.max > z.min)) { el.zoomWrap.hidden = true; return; }
    var saved = NaN;
    try { saved = parseFloat(window.localStorage.getItem(ZOOM_KEY)); } catch (e) {}
    var target = isFinite(saved) ? saved : DEFAULT_ZOOM;
    target = Math.min(z.max, Math.max(z.min, target));
    el.zoomSlider.min = z.min;
    el.zoomSlider.max = z.max;
    el.zoomSlider.step = z.step || 0.1;
    el.zoomSlider.value = target;
    el.zoomWrap.hidden = false;
    applyZoom(target);
  }

  function applyZoom(value) {
    if (!state.track) return;
    state.zoomTarget = value;
    el.zoomLabel.textContent = value.toFixed(1) + '×';
    if (state.zoomBusy) return;
    state.zoomBusy = true;
    var run = function () {
      var t = state.zoomTarget;
      var track = state.track;
      if (!track) { state.zoomBusy = false; return; }
      track.applyConstraints({ advanced: [{ zoom: t }] }).catch(function () {}).then(function () {
        if (state.zoomTarget !== t && state.track) { run(); return; }
        state.zoomBusy = false;
        try { window.localStorage.setItem(ZOOM_KEY, String(state.zoomTarget)); } catch (e) {}
      });
    };
    run();
  }

  function refocusAt(clientX, clientY) {
    var t = state.track;
    if (!t || !t.applyConstraints) return;
    var caps = null;
    try { caps = t.getCapabilities ? t.getCapabilities() : null; } catch (e) {}
    var adv = [];
    if (caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('single-shot') >= 0) {
      adv.push({ focusMode: 'single-shot' });
    }
    if (caps && caps.pointsOfInterest !== undefined) {
      var vr = el.video.getBoundingClientRect();
      if (vr.width && vr.height) {
        adv.push({ pointsOfInterest: [{
          x: Math.min(1, Math.max(0, (clientX - vr.left) / vr.width)),
          y: Math.min(1, Math.max(0, (clientY - vr.top) / vr.height))
        }] });
      }
    }
    if (!adv.length) return;
    showFocusRing(clientX, clientY);
    t.applyConstraints({ advanced: adv }).catch(function () {}).then(function () {
      window.setTimeout(function () { if (state.track === t) improveTrack(); }, 900);
    });
  }

  function showFocusRing(x, y) {
    var sr = el.stage.getBoundingClientRect();
    el.focusRing.style.left = (x - sr.left) + 'px';
    el.focusRing.style.top = (y - sr.top) + 'px';
    el.focusRing.classList.remove('go');
    void el.focusRing.offsetWidth;
    el.focusRing.classList.add('go');
  }

  function updateTorchButton() {
    var caps = null;
    try { caps = state.track && state.track.getCapabilities ? state.track.getCapabilities() : null; } catch (e) {}
    var supported = !!(caps && caps.torch);
    el.torchBtn.disabled = !supported;
    el.torchBtn.classList.toggle('active', supported && state.torchOn);
    if (!supported) state.torchOn = false;
  }

  function toggleTorch() {
    if (!state.track) return;
    var next = !state.torchOn;
    state.track.applyConstraints({ advanced: [{ torch: next }] }).then(function () {
      state.torchOn = next;
      updateTorchButton();
    }).catch(function () {
      setNotice('The flashlight is not controllable on this camera.', 'warn');
      el.torchBtn.disabled = true;
    });
  }

  function switchCamera() {
    if (state.deviceIds.length < 2) return;
    el.flipBtn.disabled = true;
    state.deviceIndex = (state.deviceIndex + 1) % state.deviceIds.length;
    state.torchOn = false;
    openStream().catch(showCameraError).then(function () {
      el.flipBtn.disabled = state.deviceIds.length < 2;
    });
  }

  function showCameraError(err) {
    var name = (err && (err.name || err.code)) || '';
    var msg;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      msg = 'Camera permission was blocked. Allow camera access for this site in your browser settings, then tap Start scanning again.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      msg = 'No usable camera was found on this device.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      msg = 'The camera is busy. Close any other app or tab using it and try again.';
    } else if (name === 'InsecureContext') {
      msg = 'Camera access needs a secure connection. Open this page over https:// (or on localhost).';
    } else if (name === 'NotSupportedError') {
      msg = 'This browser cannot reach the camera. Try Chrome on Android or Safari on iOS.';
    } else {
      msg = 'Could not start the camera' + (err && err.message ? ': ' + err.message : '.');
    }
    setNotice(msg, null);
  }

  /* ---------------- scan loop ---------------- */

  function schedule(delay) {
    if (!state.running || state.paused) return;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(scanTick, delay == null ? SCAN_INTERVAL_MS : delay);
  }

  // Copies what is inside the on-screen frame into a canvas. Defaults are the barcode
  // decoder's; the MRP reader passes its own canvas, size limit and padding.
  function captureRegion(cv, cx, maxEdge, padRatio) {
    cv = cv || canvas;
    cx = cx || ctx;
    maxEdge = maxEdge || MAX_EDGE;
    padRatio = padRatio == null ? REGION_PAD : padRatio;
    var v = el.video;
    if (!v.videoWidth || !v.videoHeight || v.readyState < 2) return false;

    var vr = v.getBoundingClientRect();
    var fr = el.frame.getBoundingClientRect();
    if (!vr.width || !fr.width) return false;

    // The video is object-fit: cover, so map the on-screen frame back to source pixels.
    var scale = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    var offX = (vr.width - v.videoWidth * scale) / 2;
    var offY = (vr.height - v.videoHeight * scale) / 2;

    // Decode a padded region: codes held slightly off-frame should still read.
    var pad = Math.min(fr.width, fr.height) * padRatio;
    var sx = (fr.left - pad - vr.left - offX) / scale;
    var sy = (fr.top - pad - vr.top - offY) / scale;
    var sw = (fr.width + pad * 2) / scale;
    var sh = (fr.height + pad * 2) / scale;

    sx = Math.max(0, Math.min(sx, v.videoWidth - 1));
    sy = Math.max(0, Math.min(sy, v.videoHeight - 1));
    sw = Math.max(1, Math.min(sw, v.videoWidth - sx));
    sh = Math.max(1, Math.min(sh, v.videoHeight - sy));

    var k = Math.min(1, maxEdge / Math.max(sw, sh));
    cv.width = Math.max(1, Math.round(sw * k));
    cv.height = Math.max(1, Math.round(sh * k));
    cx.drawImage(v, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    return true;
  }

  function scanTick() {
    if (!state.running || state.paused) return;
    var t0 = Date.now();
    var done = function () {
      // Keep the cadence tight when decoding is fast, back off when it is slow.
      schedule(Date.now() - t0 > 120 ? 20 : SCAN_INTERVAL_MS);
    };

    if (state.engine === 'native') {
      // Full-resolution frame straight from the video element — no canvas copy.
      var v = el.video;
      if (v.readyState < 2 || !v.videoWidth) { schedule(); return; }
      state.detector.detect(v).then(function (codes) {
        if (codes && codes.length) onCode(codes[0].rawValue, codes[0].format);
      }).catch(function () {}).then(nativeBackup).then(done);
      return;
    }

    if (!captureRegion()) { schedule(); return; }

    if (state.engine === 'wasm') {
      var img;
      try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); }
      catch (e) { schedule(); return; }
      state.wasm.readBarcodes(img, READER_OPTS).then(function (results) {
        var r = results && results[0];
        if (r && r.text) onCode(r.text, r.format);
      }).catch(function () {}).then(done);
      return;
    }

    try {
      var Z = window.ZXing;
      var source = new Z.HTMLCanvasElementLuminanceSource(canvas);
      var bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
      var res = state.zxing.decode(bitmap, state.zxingHints);
      if (res) onCode(res.getText(), Z.BarcodeFormat[res.getBarcodeFormat()]);
    } catch (e) {
      // NotFoundException on every empty frame — expected.
    }
    try { state.zxing.reset(); } catch (e) {}
    done();
  }

  // If the native detector has gone a while without reading anything, pull in the
  // wasm decoder and interleave it — it handles cases ML Kit sometimes misses.
  function nativeBackup() {
    if (!state.running || state.paused) return;
    if (Date.now() - state.lastHitAt < BACKUP_AFTER_MS) return;
    if (!state.wasm) { loadWasm().catch(function () {}); return; }
    state.backupN = (state.backupN + 1) % 3;
    if (state.backupN !== 0) return;
    if (!captureRegion()) return;
    var img;
    try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { return; }
    return state.wasm.readBarcodes(img, READER_OPTS).then(function (results) {
      var r = results && results[0];
      if (r && r.text) {
        onCode(r.text, r.format);
        // The native detector is evidently missing these codes — keep the
        // backup engaged instead of letting this hit reset the dry-spell clock.
        state.lastHitAt = 0;
      }
    }).catch(function () {});
  }

  function onCode(value, format) {
    if (value == null || value === '') return;
    var now = Date.now();
    state.lastHitAt = now;
    if (value === state.lastValue && now - state.lastAt < DUPE_WINDOW_MS) {
      state.lastAt = now;
      if (state.mode === 'audit') {
        state.dupeAt = state.armedAt = now;
        updateArmed();
        window.clearTimeout(state.dupeTimer);
        state.dupeTimer = window.setTimeout(updateArmed, DUPE_HINT_MS + 50);
      }
      return;
    }
    state.lastValue = value;
    state.lastAt = now;

    var entry = { value: value, format: prettyFormat(format), at: now };
    feedback();

    if (state.mode === 'audit') {
      if (auditActive()) auditBarcode(entry);
    } else if (state.mode === 'confirm') {
      state.pending = entry;
      state.paused = true;
      window.clearTimeout(state.timer);
      showConfirm(entry, true);
    } else {
      commit(entry);
      showConfirm(entry, false);
    }
  }

  function commit(entry) {
    state.sessionCount += 1;
    el.sessionCount.textContent = String(state.sessionCount);
    el.sessionChip.hidden = false;
    addHistory(entry);
  }

  /* ---------------- confirmation ---------------- */

  function showConfirm(entry, blocking) {
    window.clearTimeout(state.confirmTimer);
    el.confirmFormat.textContent = entry.format;
    el.confirmValue.textContent = entry.value;
    el.confirmIndex.textContent = blocking
      ? 'scan ' + (state.sessionCount + 1)
      : '#' + state.sessionCount + ' · ' + timeLabel(entry.at);
    el.confirmActions.hidden = !blocking;
    el.confirm.classList.toggle('blocking', !!blocking);
    el.confirm.hidden = false;
    el.armed.hidden = true;
    if (blocking) {
      el.keepBtn.focus({ preventScroll: true });
    } else {
      state.confirmTimer = window.setTimeout(hideConfirm, AUTO_CONFIRM_MS);
    }
  }

  function hideConfirm() {
    window.clearTimeout(state.confirmTimer);
    el.confirm.hidden = true;
    el.confirm.classList.remove('blocking');
    updateArmed();
  }

  function resumeAfterConfirm() {
    state.pending = null;
    state.lastAt = Date.now() + (RESUME_COOLDOWN_MS - DUPE_WINDOW_MS);
    hideConfirm();
    if (state.running) {
      state.paused = false;
      schedule(0);
    }
  }

  function keepPending() {
    if (state.pending) commit(state.pending);
    resumeAfterConfirm();
  }

  function discardPending() {
    resumeAfterConfirm();
  }

  function updateArmed() {
    var audit = state.mode === 'audit', now = Date.now();
    el.armed.textContent = !audit ? 'Ready for the next code'
      : now - state.dupeAt < DUPE_HINT_MS ? 'Same barcode — take it out of view to count another'
      : now - state.armedAt >= NO_BARCODE_HINT_MS ? 'No barcode yet — hold it flat, zoom or use the flash'
      : 'Scan a barcode';
    el.armed.hidden = !(state.running && !state.paused && el.confirm.hidden && el.audit.hidden &&
                        (audit || state.sessionCount > 0));
  }

  /* ---------------- feedback ---------------- */

  function ensureAudio() {
    if (audioCtx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
  }

  // `warn` plays two low beeps and a longer buzz: something needs the person's eyes.
  function feedback(warn) {
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
    if (navigator.vibrate) { try { navigator.vibrate(warn ? [60, 80, 60] : 40); } catch (e) {} }
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var tones = warn ? [[520, 0], [520, 0.19]] : [[950, 0]];
      tones.forEach(function (tn) {
        var t = audioCtx.currentTime + tn[1];
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(tn[0], t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
      });
    } catch (e) {}
  }

  /* ---------------- history ---------------- */

  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        state.history = parsed.filter(function (e) { return e && typeof e.value === 'string'; });
      }
    } catch (e) { state.history = []; }
  }

  function saveHistory() {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch (e) {}
  }

  function addHistory(entry) {
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    var list = el.history;
    while (list.firstChild) list.removeChild(list.firstChild);

    el.historyCount.textContent = String(state.history.length);
    el.historyEmpty.hidden = state.history.length > 0;
    el.clearBtn.hidden = state.history.length === 0;
    el.exportBtn.hidden = state.history.length === 0;

    state.history.forEach(function (entry) {
      var li = document.createElement('li');

      var main = document.createElement('div');
      main.className = 'h-main';

      var val = document.createElement('div');
      val.className = 'h-val';
      val.textContent = entry.value;

      var meta = document.createElement('div');
      meta.className = 'h-meta';
      meta.textContent = (entry.format || 'Code') + ' · ' + timeLabel(entry.at);

      main.appendChild(val);
      main.appendChild(meta);

      var badge = document.createElement('span');
      badge.className = 'h-copy';
      badge.textContent = 'Copy';

      li.appendChild(main);
      li.appendChild(badge);
      li.addEventListener('click', function () {
        copyText(entry.value).then(function (ok) {
          badge.textContent = ok ? 'Copied' : 'Failed';
          window.setTimeout(function () { badge.textContent = 'Copy'; }, 1400);
        });
      });

      list.appendChild(li);
    });
  }

  function clearHistory() {
    state.history = [];
    saveHistory();
    renderHistory();
  }

  function exportAll() {
    var lines = state.history.slice().reverse().map(function (e) { return e.value; });
    copyText(lines.join('\n')).then(function (ok) {
      el.exportBtn.textContent = ok ? 'Copied ' + lines.length : 'Copy failed';
      window.setTimeout(function () { el.exportBtn.textContent = 'Copy all'; }, 1600);
    });
  }

  /* ---------------- clipboard ---------------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ---------------- audit: MRP reader worker ---------------- */

  function ensureOcr() {
    var o = state.ocr;
    if (o.worker || o.error) return;
    if (!window.Worker || !window.WebAssembly) {
      o.error = 'This browser cannot run the price reader.';
      renderOcrState();
      return;
    }
    try { o.worker = new Worker('js/ocr-worker.js'); }
    catch (e) { o.error = 'The price reader could not start.'; renderOcrState(); return; }
    o.worker.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === 'ready') { o.ready = true; renderOcrState(); }
      else if (m.type === 'error') { o.error = 'The price reader did not load (' + m.message + ').'; renderOcrState(); }
      else if (m.type === 'result' && o.waiting[m.id]) {
        var cb = o.waiting[m.id];
        delete o.waiting[m.id];
        cb(m);
      }
    };
    o.worker.onerror = function (e) {
      o.error = 'The price reader stopped' + (e && e.message ? ' (' + e.message + ')' : '') + '.';
      renderOcrState();
    };
    renderOcrState();
  }

  function ocrRead(img, opts) {
    var o = state.ocr;
    return new Promise(function (resolve, reject) {
      var id = ++o.seq;
      o.waiting[id] = function (m) { if (m.error) reject(new Error(m.error)); else resolve(m); };
      o.worker.postMessage({ type: 'read', id: id, buffer: img.data.buffer, width: img.width, height: img.height, opts: opts },
        [img.data.buffer]);
    });
  }

  function renderOcrState() {
    var o = state.ocr, msg = '', warn = false;
    if (o.error) { msg = o.error + ' You can still type each price.'; warn = true; }
    else if (o.worker && !o.ready) msg = 'Loading the price reader… first time only, about 27 MB.';
    el.ocrState.textContent = msg;
    el.ocrState.className = 'ocr-state' + (warn ? ' warn' : '');
    el.ocrState.hidden = !msg;
    if (state.audit.step === 'mrp') renderAuditCard();
  }

  /* ---------------- audit: session ---------------- */
  // session: { startedAt, endedAt, scans: [{ code, mrp, at, how }] }. A product is its
  // barcode + price; every scan is one unit of that product.

  function auditActive() { return !!state.session && !state.session.endedAt; }

  // EAN-13 "0691027644058" and UPC-A "691027644058" are the same product, and engines
  // disagree on which they report.
  function normCode(code) {
    var s = String(code).trim();
    return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
  }

  function productKey(code, mrp) { return normCode(code) + '|' + mrp.toFixed(2); }

  function auditProducts() {
    var map = {}, list = [];
    (state.session ? state.session.scans : []).forEach(function (s) {
      var k = productKey(s.code, s.mrp), p = map[k];
      if (!p) { p = map[k] = { key: k, code: s.code, mrp: s.mrp, qty: 0, last: 0 }; list.push(p); }
      p.qty += 1;
      p.last = s.at;
    });
    return list.sort(function (a, b) { return b.last - a.last; });
  }

  function pricesCounted(code) {
    var n = normCode(code), out = [];
    state.session.scans.forEach(function (s) {
      if (normCode(s.code) === n && out.indexOf(s.mrp) < 0) out.push(s.mrp);
    });
    return out;
  }

  function loadSession() {
    try {
      window.localStorage.removeItem('scan.audit.v1');
      var s = JSON.parse(window.localStorage.getItem(AUDIT_KEY) || 'null');
      if (s && Array.isArray(s.scans)) state.session = s;
    } catch (e) { state.session = null; }
  }

  function saveSession() {
    try {
      if (state.session) window.localStorage.setItem(AUDIT_KEY, JSON.stringify(state.session));
      else window.localStorage.removeItem(AUDIT_KEY);
    } catch (e) {}
  }

  function startNewAudit() {
    var old = state.session;
    if (old && old.scans.length &&
        !window.confirm('Start a new audit? The last one (' + old.scans.length + ' units) will be cleared from this phone. Its Excel file is not affected.')) return;
    state.session = { startedAt: Date.now(), endedAt: 0, scans: [] };
    state.rowEdit = null;
    saveSession();
    renderAudit();
    start();
  }

  function endAudit() {
    var s = state.session, n = s.scans.length;
    if (!n) {
      if (!window.confirm('Nothing has been scanned. Discard this audit?')) return;
      if (state.running) stop();
      state.session = null;
      saveSession();
      renderAudit();
      return;
    }
    if (!window.confirm('End this audit with ' + n + ' units of ' + auditProducts().length + ' products? The Excel file downloads now, and no more scans can be added.')) return;
    if (state.running) stop();
    s.endedAt = Date.now();
    state.rowEdit = null;
    saveSession();
    renderAudit();
    downloadExcel();
  }

  function stamp(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function downloadExcel() {
    var rows = auditProducts().sort(function (a, b) {
      return a.code < b.code ? -1 : a.code > b.code ? 1 : a.mrp - b.mrp;
    }).map(function (p) { return [p.code, p.mrp, p.qty]; });
    var bytes = Xlsx.build({
      name: 'Audit',
      columns: [{ title: 'Barcode', width: 20 }, { title: 'MRP', width: 12, money: true }, { title: 'Count', width: 10 }],
      rows: rows
    });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: Xlsx.MIME }));
    link.download = 'audit-' + stamp(state.session.endedAt || Date.now()) + '.xlsx';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  /* ---------------- audit: one product at a time ---------------- */
  // Barcode first, then the price. Both in one view is one scan; otherwise the barcode
  // is held on screen, however long the price takes. Steps:
  //   'barcode' waiting for a code · 'mrp' reading the price · 'done' just counted (the
  //   next barcode can already be scanned) · 'edit' correcting what was just counted

  var EVIDENCE = {
    usp: 'the label’s USP line agrees',
    seen: 'same price as earlier units',
    repeat: 'read the same twice',
    accepted: 'as read',
    typed: 'typed in'
  };

  function auditBarcode(entry) {
    state.paused = true;
    window.clearTimeout(state.timer);
    state.audit = { step: 'mrp', code: entry.value, frames: [], busy: false, typing: false, decision: null };
    el.frame.classList.add('label');
    ensureOcr();
    renderAuditCard();
    scheduleMrp(300);
  }

  function scheduleMrp(delay) {
    window.clearTimeout(state.auditTimer);
    state.auditTimer = window.setTimeout(mrpTick, delay || 0);
  }

  function mrpTick() {
    var a = state.audit;
    if (!state.running || a.step !== 'mrp' || a.busy || a.typing || state.ocr.error) return;
    if (!state.ocr.ready) { scheduleMrp(300); return; }
    if (!captureRegion(ocrCanvas, ocrCtx, OCR_MAX_EDGE, OCR_PAD)) { scheduleMrp(200); return; }
    var img;
    try { img = ocrCtx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height); }
    catch (e) { scheduleMrp(200); return; }
    var plan = Mrp.nextAttempt(a.frames);
    a.busy = true;
    ocrRead(img, plan).then(function (res) {
      a.busy = false;
      if (state.audit !== a || a.step !== 'mrp' || a.typing) return;
      var seen = pricesCounted(a.code);
      var r = Mrp.assess(res.lines, seen);
      r.skew = res.skew;
      r.flip = plan.flip;
      a.frames.push(r);
      if (a.frames.length > Mrp.MAX_FRAMES + 1) a.frames.shift();
      var d = Mrp.decide(a.frames, seen);
      if (d.status === 'accepted') { countUnit(a.code, d.value, d.evidence); return; }
      a.decision = d;
      renderAuditCard();
      // Not coming yet: the pack may still be being turned, so keep looking, more gently.
      scheduleMrp(d.status === 'pending' ? 60 : 500);
    }, function (err) {
      a.busy = false;
      state.ocr.error = 'The price reader failed (' + err.message + ').';
      renderOcrState();
    });
  }

  function countUnit(code, mrp, how) {
    var scan = { code: code, mrp: mrp, at: Date.now(), how: how };
    state.session.scans.push(scan);
    saveSession();
    renderAudit();
    state.sessionCount += 1;
    el.sessionCount.textContent = String(state.sessionCount);
    el.sessionChip.hidden = false;
    feedback();
    showCounted(scan);
  }

  // The card stays up for a moment for Edit / Undo, but the next barcode can already scan.
  function showCounted(scan) {
    window.clearTimeout(state.auditTimer);
    state.audit = { step: 'done', code: scan.code, scan: scan };
    // The pack is still in hand: reading the price outlasted the window set by its barcode.
    state.lastValue = scan.code;
    state.lastAt = Date.now();
    resumeBarcode();
    renderAuditCard();
    var a = state.audit;
    state.auditTimer = window.setTimeout(function () {
      if (state.audit === a) { state.audit = { step: 'barcode' }; renderAuditCard(); }
    }, COUNTED_MS);
  }

  function resumeBarcode() {
    el.frame.classList.remove('label');
    state.armedAt = Date.now();
    window.setTimeout(updateArmed, NO_BARCODE_HINT_MS + 50);
    if (state.running && state.paused) { state.paused = false; schedule(0); }
  }

  function auditReset() {
    window.clearTimeout(state.auditTimer);
    state.audit = { step: 'barcode' };
    resumeBarcode();
    renderAuditCard();
  }

  // Rescan: the code just read must be readable again straight away.
  function rescanBarcode() {
    state.lastValue = '';
    auditReset();
  }

  function auditCancel() {
    var a = state.audit;
    if (a.step === 'edit' || a.typing) closeTyping();
    else if (a.step === 'mrp') rescanBarcode();
  }

  function parsePrice(text) {
    var s = String(text).replace(/₹|rs\.?|\/-|[,\s]/gi, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var v = Math.round(parseFloat(s) * 100) / 100;
    return v > 0 ? v : null;
  }

  function submitPrice(ev) {
    ev.preventDefault();
    var a = state.audit, v = parsePrice(el.auditOtherInput.value);
    if (v == null) { el.auditOtherInput.focus(); el.auditOtherInput.select(); return; }
    if (a.step === 'mrp') {
      countUnit(a.code, v, 'typed');
    } else if (a.step === 'edit') {
      a.scan.mrp = v;
      a.scan.how = 'typed';
      saveSession();
      renderAudit();
      showCounted(a.scan);
    }
  }

  function closeTyping() {
    var a = state.audit;
    if (a.step === 'edit') { showCounted(a.scan); return; }
    a.typing = false;
    renderAuditCard();
    scheduleMrp(0);
  }

  function openTyping(value) {
    el.auditOtherInput.value = value == null ? '' : String(value);
    renderAuditCard();
    el.auditOtherInput.focus();
    el.auditOtherInput.select();
  }

  function editCounted() {
    var a = state.audit;
    window.clearTimeout(state.auditTimer);
    window.clearTimeout(state.timer);
    state.paused = true;           // no new barcode while the price is being corrected
    state.audit = { step: 'edit', code: a.code, scan: a.scan };
    openTyping(a.scan.mrp);
  }

  function undoCounted() {
    var a = state.audit, i = state.session.scans.indexOf(a.scan);
    if (i >= 0) state.session.scans.splice(i, 1);
    saveSession();
    renderAudit();
    state.sessionCount = Math.max(0, state.sessionCount - 1);
    el.sessionCount.textContent = String(state.sessionCount);
    rescanBarcode();
  }

  /* ---------------- audit: rendering ---------------- */

  function addPill(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = label;
    b.addEventListener('click', onClick);
    el.auditActions.appendChild(b);
  }

  function renderAuditCard() {
    var a = state.audit;
    el.audit.hidden = a.step === 'barcode';
    updateArmed();
    if (a.step === 'barcode') return;
    var typing = a.step === 'edit' || !!a.typing;
    var d = a.decision, stuck = !!d && (d.status === 'unsure' || d.status === 'unreadable');
    el.auditCard.className = 'audit-card' + (a.step === 'done' ? ' ok' : stuck ? ' warn' : '');
    el.auditStep.textContent = a.step === 'done' ? 'Counted'
      : a.step === 'edit' ? 'Edit the price'
      : typing ? 'Type the price' : 'Barcode read — now the price';
    el.auditCode.textContent = a.code;
    el.auditOther.hidden = !typing;

    el.auditCancel.hidden = a.step === 'done';
    el.auditCancel.textContent = typing ? 'Back' : 'Rescan barcode';

    while (el.auditActions.firstChild) el.auditActions.removeChild(el.auditActions.firstChild);
    if (a.step === 'done') {
      addPill('Edit price', editCounted);
      addPill('Undo', undoCounted);
    } else if (!typing) {
      if (stuck && d.value != null) addPill('Use ' + Mrp.format(d.value), function () { countUnit(a.code, d.value, 'accepted'); });
      addPill('Type price', function () { a.typing = true; openTyping(d ? d.value : null); });
    }

    var s = el.auditStatus;
    while (s.firstChild) s.removeChild(s.firstChild);
    if (a.step === 'done') {
      var qty = 0, key = productKey(a.scan.code, a.scan.mrp);
      state.session.scans.forEach(function (x) { if (productKey(x.code, x.mrp) === key) qty += 1; });
      addText(s, Mrp.format(a.scan.mrp), true);
      addText(s, ' — ' + (EVIDENCE[a.scan.how] || 'as read') + ' · now ×' + qty);
    } else if (a.step === 'mrp' && !typing) {
      var o = state.ocr;
      if (o.error) addText(s, 'The price reader is unavailable. Type the price.');
      else if (!o.ready) addText(s, 'Loading the price reader…');
      else if (d && d.status === 'unreadable') addText(s, 'Price not recognised. Hold the MRP inside the frame to rescan it, or type it.');
      else if (d && d.status === 'unsure') {
        addText(s, 'Read ');
        addText(s, Mrp.format(d.value), true);
        addText(s, ' but could not confirm it. Rescan, use it, or type it.');
      } else if (d && d.value != null) addText(s, 'Read ' + Mrp.format(d.value) + ' — checking…');
      else addText(s, 'Hold the MRP inside the frame.');
    }
  }

  function addText(parent, text, strong) {
    var n = document.createElement(strong ? 'strong' : 'span');
    n.textContent = text;
    parent.appendChild(n);
  }

  function renderAudit() {
    var s = state.session, active = auditActive();
    var products = auditProducts(), units = s ? s.scans.length : 0;
    var time = function (ms) {
      try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    };
    var tally = products.length + (products.length === 1 ? ' product · ' : ' products · ') + units + (units === 1 ? ' unit' : ' units');
    el.auditTitle.textContent = active ? 'Audit in progress' : s ? 'Audit ended' : 'No audit in progress';
    el.auditSub.textContent = active ? 'Started ' + time(s.startedAt) + ' · ' + tally
      : s ? 'Ended ' + time(s.endedAt) + ' · ' + tally
      : 'Start a new audit, then scan each product’s barcode and price.';
    el.auditEndBtn.hidden = !active;
    el.auditDownloadBtn.hidden = !s || active;
    el.auditUnits.textContent = String(units);
    el.auditEmpty.hidden = products.length > 0;

    var list = el.auditList;
    while (list.firstChild) list.removeChild(list.firstChild);
    products.forEach(function (p) {
      var li = document.createElement('li');
      var main = document.createElement('div');
      main.className = 'h-main';
      var val = document.createElement('div');
      val.className = 'h-val';
      val.textContent = p.code;
      var meta = document.createElement('div');
      meta.className = 'h-meta';
      meta.textContent = 'Last counted ' + timeLabel(p.last);
      main.appendChild(val);
      main.appendChild(meta);
      li.appendChild(main);

      var editing = state.rowEdit && state.rowEdit.key === p.key;
      if (editing) {
        li.appendChild(rowEditor(p));
      } else {
        var chip = document.createElement(active ? 'button' : 'span');
        chip.className = 'mrp-chip';
        chip.textContent = Mrp.format(p.mrp);
        if (active) {
          chip.type = 'button';
          chip.setAttribute('aria-label', 'Edit the price of ' + p.code);
          chip.addEventListener('click', function () {
            state.rowEdit = { key: p.key, value: String(p.mrp) };
            renderAudit();
          });
        }
        li.appendChild(chip);
        if (active) li.appendChild(stepButton('−', 'Remove one unit of ' + p.code, function () { removeUnit(p); }));
        var qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = '×' + p.qty;
        li.appendChild(qty);
        if (active) li.appendChild(stepButton('+', 'Add one unit of ' + p.code, function () { addUnit(p); }));
      }
      list.appendChild(li);
    });
    if (state.rowEdit) {
      var input = list.querySelector('input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      else state.rowEdit = null;
    }
    renderStartLabel();
  }

  function stepButton(text, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'minus';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function rowEditor(p) {
    var form = document.createElement('form');
    form.className = 'row-edit';
    var input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.value = state.rowEdit.value;
    input.setAttribute('aria-label', 'New price for ' + p.code);
    input.addEventListener('input', function () { state.rowEdit.value = input.value; });
    var save = document.createElement('button');
    save.type = 'submit';
    save.className = 'pill';
    save.textContent = 'Save';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pill';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { state.rowEdit = null; renderAudit(); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = parsePrice(input.value);
      if (v == null) { input.focus(); input.select(); return; }
      state.session.scans.forEach(function (x) {
        if (productKey(x.code, x.mrp) === p.key) { x.mrp = v; x.how = 'typed'; }
      });
      state.rowEdit = null;
      saveSession();
      renderAudit();
    });
    form.appendChild(input);
    form.appendChild(save);
    form.appendChild(cancel);
    return form;
  }

  // From the list, so it must not disturb a product being scanned right now.
  function addUnit(p) {
    state.session.scans.push({ code: p.code, mrp: p.mrp, at: Date.now(), how: 'typed' });
    saveSession();
    renderAudit();
  }

  function removeUnit(p) {
    var scans = state.session.scans;
    for (var i = scans.length - 1; i >= 0; i--) {
      if (productKey(scans[i].code, scans[i].mrp) === p.key) { scans.splice(i, 1); break; }
    }
    saveSession();
    renderAudit();
  }

  function renderStartLabel() {
    if (state.running || state.starting) return;
    el.startLabel.textContent = state.mode !== 'audit' ? 'Start scanning'
      : auditActive() ? 'Resume scanning' : 'Start new audit';
  }

  /* ---------------- mode ---------------- */

  function setMode(mode) {
    var prev = state.mode;
    state.mode = (mode === 'confirm' || mode === 'audit') ? mode : 'auto';
    [[el.modeAuto, 'auto'], [el.modeConfirm, 'confirm'], [el.modeAudit, 'audit']].forEach(function (p) {
      p[0].classList.toggle('is-on', state.mode === p[1]);
      p[0].setAttribute('aria-pressed', String(state.mode === p[1]));
    });
    try { window.localStorage.setItem(MODE_KEY, state.mode); } catch (e) {}
    el.scanSection.hidden = state.mode === 'audit';
    el.auditSection.hidden = state.mode !== 'audit';
    if (prev === 'audit' && state.mode !== 'audit') auditReset();
    if (state.mode === 'audit' && state.running && !auditActive()) stop();
    renderStartLabel();
    // Switching out of confirm mode must not leave the loop parked.
    if (state.mode !== 'confirm' && state.pending) { state.pending = null; resumeAfterConfirm(); }
    // Start the model download before the first price is due.
    if (state.mode === 'audit') ensureOcr();
  }

  /* ---------------- start / stop ---------------- */

  function secureEnough() {
    if (window.isSecureContext) return true;
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || location.protocol === 'file:';
  }

  function start() {
    if (state.starting) return;
    state.starting = true;
    setNotice('', null);
    el.startBtn.disabled = true;
    el.startLabel.textContent = 'Starting…';

    Promise.resolve().then(function () {
      if (!secureEnough()) { var e = new Error('insecure'); e.name = 'InsecureContext'; throw e; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        var e2 = new Error('unsupported'); e2.name = 'NotSupportedError'; throw e2;
      }
      ensureAudio();
      return setupEngine();
    }).then(openStream).then(function () {
      state.running = true;
      state.paused = false;
      state.pending = null;
      state.lastValue = '';
      state.lastAt = 0;
      state.sessionCount = 0;
      state.lastHitAt = Date.now();
      state.backupN = 0;
      state.armedAt = Date.now();
      window.setTimeout(updateArmed, NO_BARCODE_HINT_MS + 50);
      if (state.mode === 'audit') ensureOcr();
      el.sessionCount.textContent = '0';
      el.sessionChip.hidden = false;
      el.stage.classList.add('live');
      el.startBtn.classList.add('stopping');
      el.startLabel.textContent = 'Stop scanning';
      hideConfirm();
      schedule(0);
    }).catch(function (err) {
      state.running = false;
      closeStream();
      el.stage.classList.remove('live');
      showCameraError(err);
    }).then(function () {
      state.starting = false;
      el.startBtn.disabled = false;
      renderStartLabel();
    });
  }

  function stop() {
    state.running = false;
    if (state.audit.step !== 'barcode') auditReset();
    state.paused = false;
    state.pending = null;
    window.clearTimeout(state.timer);
    if (state.torchOn && state.track) {
      try { state.track.applyConstraints({ advanced: [{ torch: false }] }); } catch (e) {}
    }
    state.torchOn = false;
    closeStream();
    hideConfirm();
    el.stage.classList.remove('live');
    el.startBtn.classList.remove('stopping');
    renderStartLabel();
    el.torchBtn.disabled = true;
    el.torchBtn.classList.remove('active');
    el.flipBtn.disabled = true;
    el.zoomWrap.hidden = true;
    el.sessionChip.hidden = state.sessionCount === 0;
  }

  /* ---------------- wiring ---------------- */

  el.startBtn.addEventListener('click', function () {
    if (state.running) stop();
    else if (state.mode === 'audit' && !auditActive()) startNewAudit();
    else start();
  });
  el.torchBtn.addEventListener('click', toggleTorch);
  el.flipBtn.addEventListener('click', switchCamera);
  el.clearBtn.addEventListener('click', clearHistory);
  el.exportBtn.addEventListener('click', exportAll);
  el.keepBtn.addEventListener('click', keepPending);
  el.discardBtn.addEventListener('click', discardPending);
  el.modeAuto.addEventListener('click', function () { setMode('auto'); });
  el.modeConfirm.addEventListener('click', function () { setMode('confirm'); });
  el.modeAudit.addEventListener('click', function () { setMode('audit'); });
  el.zoomSlider.addEventListener('input', function () {
    applyZoom(parseFloat(el.zoomSlider.value));
  });
  el.stage.addEventListener('click', function (ev) {
    // Refocusing matters most while the MRP is being read, so allow it then too.
    if (!state.running || (state.paused && state.audit.step !== 'mrp')) return;
    if (ev.target.closest && (ev.target.closest('.zoom') || ev.target.closest('.audit-card'))) return;
    refocusAt(ev.clientX, ev.clientY);
  });

  el.auditCancel.addEventListener('click', auditCancel);
  el.auditOther.addEventListener('submit', submitPrice);
  el.auditEndBtn.addEventListener('click', endAudit);
  el.auditDownloadBtn.addEventListener('click', downloadExcel);

  // Tapping a non-blocking confirmation dismisses it early.
  el.confirm.addEventListener('click', function (ev) {
    if (state.paused) return;
    if (ev.target.closest && ev.target.closest('.confirm-value')) return;
    hideConfirm();
  });

  document.addEventListener('keydown', function (ev) {
    if (state.mode === 'audit') {
      if (ev.key === 'Escape' && (state.audit.step === 'mrp' || state.audit.step === 'edit')) { ev.preventDefault(); auditCancel(); }
      return;
    }
    if (!state.paused) return;
    if (ev.key === 'Enter') { ev.preventDefault(); keepPending(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); discardPending(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.running) {
      stop();
      setNotice('Camera released while the page was in the background. Tap the button below to resume.', 'info');
    }
  });

  window.addEventListener('pagehide', stop);

  try { setMode(window.localStorage.getItem(MODE_KEY) || 'auto'); } catch (e) { setMode('auto'); }
  loadHistory();
  renderHistory();
  loadSession();
  renderAudit();

  if (!secureEnough()) {
    setNotice('This page is not on a secure connection, so the browser will not grant camera access. Open it over https://.', 'warn');
  } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setNotice('This browser does not support camera access.', 'warn');
    el.startBtn.disabled = true;
  }

  el.engineBadge.textContent = (isAndroid && 'BarcodeDetector' in window) ? 'Native' : 'WASM';
})();
