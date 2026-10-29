/* Barcode & QR scanner — rapid multi-scan, fully client-side.
 * Decoding: native BarcodeDetector on Android (ML Kit-backed), the zxing-cpp
 * WebAssembly port everywhere else, with the old JS port as a last resort.
 * Audit mode adds an on-device MRP reader (js/ocr-worker.js) checked against a
 * reference list of barcode → MRPs (js/reference.js, rules in js/mrp.js). */
/* global Mrp, Reference */
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
  var AUDIT_KEY = 'scan.audit.v1';
  var OCR_MAX_EDGE = 1280;      // label crop handed to the text reader
  var OCR_PAD = 0.12;           // read a margin round the frame: USP lines sit at label edges
  var PHOTO_MAX_EDGE = 2000;    // a chosen photo is mostly not label, so keep more pixels
  var AUDIT_DONE_MS = 1400;     // how long a recorded MRP stays on screen

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
    auditCancel: $('auditCancel'), auditProduct: $('auditProduct'), auditCode: $('auditCode'),
    auditAllowed: $('auditAllowed'), auditStatus: $('auditStatus'), auditShot: $('auditShot'),
    auditChoices: $('auditChoices'), auditOther: $('auditOther'), auditOtherInput: $('auditOtherInput'),
    auditActions: $('auditActions'), auditPhotoBtn: $('auditPhotoBtn'), auditPickBtn: $('auditPickBtn'),
    auditPhoto: $('auditPhoto'),
    refTitle: $('refTitle'), refSub: $('refSub'), refImportBtn: $('refImportBtn'),
    refRemoveBtn: $('refRemoveBtn'), refFile: $('refFile'), ocrState: $('ocrState'),
    auditUnits: $('auditUnits'), auditList: $('auditList'), auditEmpty: $('auditEmpty'),
    auditExportBtn: $('auditExportBtn'), auditClearBtn: $('auditClearBtn')
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
    // audit: the product in hand ({ step: 'barcode' | 'mrp' | 'ask' | 'done', item, frames })
    audit: { step: 'barcode' }, auditTimer: null, auditLines: [], reference: null,
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
      return;
    }
    state.lastValue = value;
    state.lastAt = now;

    var entry = { value: value, format: prettyFormat(format), at: now };
    feedback();

    if (state.mode === 'audit') {
      auditBarcode(entry);
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
    el.armed.hidden = !(state.running && !state.paused && el.confirm.hidden && state.sessionCount > 0);
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
      o.error = 'This browser cannot run the MRP reader.';
      renderOcrState();
      return;
    }
    try { o.worker = new Worker('js/ocr-worker.js'); }
    catch (e) { o.error = 'The MRP reader could not start.'; renderOcrState(); return; }
    o.worker.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === 'ready') { o.ready = true; renderOcrState(); }
      else if (m.type === 'error') { o.error = 'The MRP reader did not load (' + m.message + ').'; readerFailed(); }
      else if (m.type === 'result' && o.waiting[m.id]) {
        var cb = o.waiting[m.id];
        delete o.waiting[m.id];
        cb(m);
      }
    };
    o.worker.onerror = function (e) {
      o.error = 'The MRP reader stopped' + (e && e.message ? ' (' + e.message + ')' : '') + '.';
      readerFailed();
    };
    renderOcrState();
  }

  function readerFailed() {
    renderOcrState();
    var a = state.audit;
    if (a.step === 'mrp' && !a.busy) askPerson(a, { reason: 'unreadable', value: null });
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
    if (o.error) { msg = o.error + ' You can still choose each MRP by hand.'; warn = true; }
    else if (o.worker && !o.ready) msg = 'Loading the MRP reader… first time only, about 27 MB.';
    el.ocrState.textContent = msg;
    el.ocrState.className = 'ocr-state' + (warn ? ' warn' : '');
    el.ocrState.hidden = !msg;
    if (state.audit.step === 'mrp') renderAuditStatus();
  }

  /* ---------------- audit: one product at a time ---------------- */
  // barcode → 'mrp' (reading the label) → 'done' (recorded) or 'ask' (the person decides)

  var EVIDENCE = {
    'ref+usp': 'matches the reference, and the label’s USP line agrees',
    'ref+repeat': 'matches the reference, read the same twice',
    'usp': 'the label’s USP line agrees'
  };

  function allowedFor(item) { return item && item.ref ? item.ref.mrps : null; }

  function auditBarcode(entry) {
    state.paused = true;
    window.clearTimeout(state.timer);
    state.audit = {
      step: 'mrp', frames: [], busy: false, shot: '',
      item: { code: entry.value, format: entry.format, ref: Reference.lookup(state.reference, entry.value) }
    };
    el.frame.classList.add('label');
    el.armed.hidden = true;
    ensureOcr();
    renderAuditCard();
    scheduleMrp(600);   // a moment to turn the pack to its MRP side
  }

  function scheduleMrp(delay) {
    window.clearTimeout(state.auditTimer);
    state.auditTimer = window.setTimeout(mrpTick, delay || 0);
  }

  function mrpTick() {
    var a = state.audit;
    if (!state.running || a.step !== 'mrp' || a.busy || a.photo || state.ocr.error) return;
    if (!state.ocr.ready) { renderAuditStatus(); scheduleMrp(300); return; }
    if (!captureRegion(ocrCanvas, ocrCtx, OCR_MAX_EDGE, OCR_PAD)) { scheduleMrp(200); return; }
    readLabel(a, ocrCanvas, Mrp.nextAttempt(a.frames), null, false);
  }

  // One pass of the text reader over `cv`, folded into this product's frames.
  function readLabel(a, cv, plan, detMax, isPhoto) {
    var img;
    try { img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height); }
    catch (e) { if (!isPhoto) scheduleMrp(200); return; }
    var shot = cv.toDataURL('image/jpeg', 0.75);
    var opts = { avoid: plan.avoid, prefer: plan.prefer, flip: plan.flip };
    if (detMax) opts.detMax = detMax;
    a.busy = true;
    renderAuditStatus();
    ocrRead(img, opts).then(function (res) {
      a.busy = false;
      if (state.audit !== a || a.step !== 'mrp') return;
      var allowed = allowedFor(a.item);
      var r = Mrp.assess(res.lines, allowed);
      r.skew = res.skew;
      r.flip = plan.flip;
      a.frames.push(r);
      if (r.found || !a.shot) a.shot = shot;   // keep a frame that shows the MRP
      var d = Mrp.decide(a.frames, allowed);
      if (d.status === 'verified') record(a, d.value, 'label', d.evidence);
      else if (d.status === 'ask') askPerson(a, d);
      else if (isPhoto) askPerson(a, { reason: r.value == null ? 'unreadable' : 'unconfirmed', value: r.value });
      else { renderAuditStatus(); scheduleMrp(60); }
    }, function (err) {
      a.busy = false;
      if (state.audit !== a) return;
      state.ocr.error = 'The MRP reader failed (' + err.message + ').';
      renderOcrState();
      askPerson(a, { reason: 'unreadable', value: null });
    });
  }

  // A photo from the phone's own camera app: sharper focus than the live preview.
  function readPhoto(file) {
    var a = state.audit;
    if (!file || !a.item) return;
    ensureOcr();
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var k = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k);
      cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      window.clearTimeout(state.auditTimer);
      a.step = 'mrp';
      a.photo = true;
      renderAuditCard();
      (function go() {
        if (state.audit !== a) return;
        if (state.ocr.error) { askPerson(a, { reason: 'unreadable', value: null }); return; }
        if (!state.ocr.ready || a.busy) { window.setTimeout(go, 300); return; }
        readLabel(a, cv, Mrp.nextAttempt([]), 1600, true);
      })();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setNotice('That photo could not be opened.', 'warn');
    };
    img.src = url;
  }

  function askPerson(a, d) {
    if (state.audit !== a) return;
    window.clearTimeout(state.auditTimer);
    a.step = 'ask';
    a.ask = d;
    renderAuditCard();
    feedback(true);
  }

  // how: 'label' (verified automatically) or 'person' (chosen on the ask card)
  function record(a, value, how, evidence) {
    var ref = a.item.ref;
    var refState = !state.reference ? 'no-reference'
      : !ref ? 'barcode-unknown'
      : Mrp.inList(ref.mrps, value) ? 'match' : 'mrp-mismatch';
    var key = Reference.normCode(a.item.code) + '|' + value;
    var now = Date.now(), line = null;
    for (var i = 0; i < state.auditLines.length; i++) {
      if (state.auditLines[i].key === key) { line = state.auditLines.splice(i, 1)[0]; break; }
    }
    if (!line) {
      line = { key: key, code: a.item.code, name: ref ? ref.name : '', mrp: value,
               refState: refState, qty: 0, byLabel: 0, byPerson: 0, first: now, last: now };
    }
    state.auditLines.unshift(line);
    line.qty += 1;
    line.last = now;
    if (how === 'label') line.byLabel += 1; else line.byPerson += 1;
    saveAudit();
    renderAudit();

    state.sessionCount += 1;
    el.sessionCount.textContent = String(state.sessionCount);
    el.sessionChip.hidden = false;

    window.clearTimeout(state.auditTimer);
    a.step = 'done';
    a.result = { value: value, how: how, evidence: evidence, refState: refState };
    renderAuditCard();
    var flagged = refState !== 'match';
    if (how === 'label') feedback(flagged);
    state.auditTimer = window.setTimeout(function () {
      if (state.audit === a) auditReset();
    }, AUDIT_DONE_MS + (flagged ? 1000 : 0));
  }

  function auditReset() {
    window.clearTimeout(state.auditTimer);
    var a = state.audit;
    state.audit = { step: 'barcode' };
    el.audit.hidden = true;
    el.audit.classList.remove('blocking');
    el.frame.classList.remove('label');
    // The same pack is still in hand — do not count it again straight away.
    if (a.item) { state.lastValue = a.item.code; state.lastAt = Date.now(); }
    if (state.running && state.paused) { state.paused = false; schedule(0); }
    updateArmed();
  }

  /* ---------------- audit: rendering ---------------- */

  function addText(parent, s, strong) {
    var n = document.createElement(strong ? 'strong' : 'span');
    n.textContent = s;
    parent.appendChild(n);
  }

  function renderAuditCard() {
    var a = state.audit;
    if (!a.item || a.step === 'barcode') { el.audit.hidden = true; return; }
    var ref = a.item.ref;
    el.audit.hidden = false;
    el.audit.classList.toggle('blocking', a.step === 'ask');
    var tone = a.step === 'ask' ? ' warn'
      : a.step === 'done' ? (a.result.refState === 'match' ? ' ok' : ' warn') : '';
    el.auditCard.className = 'audit-card' + tone;
    el.auditStep.textContent = { mrp: 'Now show the MRP', ask: 'Check the MRP', done: 'Recorded' }[a.step];
    el.auditCancel.hidden = a.step === 'done';
    el.auditProduct.textContent = ref && ref.name ? ref.name : '';
    el.auditCode.textContent = a.item.code + ' · ' + a.item.format;
    if (ref) {
      el.auditAllowed.textContent = 'Expected ' + ref.mrps.map(Mrp.format).join(' · ');
      el.auditAllowed.className = 'audit-allowed';
    } else {
      el.auditAllowed.textContent = state.reference
        ? 'Barcode ' + a.item.code + ' is not in the reference list.'
        : 'No reference list — only the label itself can confirm the MRP.';
      el.auditAllowed.className = 'audit-allowed warn';
    }
    el.auditActions.hidden = a.step !== 'mrp';
    el.auditShot.hidden = a.step !== 'ask' || !a.shot;
    if (!el.auditShot.hidden) el.auditShot.src = a.shot;
    el.auditChoices.hidden = a.step !== 'ask';
    el.auditOther.hidden = true;
    if (a.step === 'ask') renderChoices(a);
    renderAuditStatus();
  }

  function renderAuditStatus() {
    var a = state.audit, s = el.auditStatus;
    if (!a.item) return;
    while (s.firstChild) s.removeChild(s.firstChild);
    if (a.step === 'mrp') {
      var o = state.ocr, last = a.frames[a.frames.length - 1];
      s.textContent = o.error ? 'The MRP reader is unavailable — tap Choose MRP.'
        : !o.ready ? 'Loading the MRP reader…'
        : a.photo ? 'Reading the photo…'
        : !a.frames.length ? 'Hold the MRP label inside the frame.'
        : last && last.value != null ? 'Read ' + Mrp.format(last.value) + ' — confirming…'
        : 'Looking for the MRP… (' + a.frames.length + ' of ' + Mrp.MAX_FRAMES + ')';
    } else if (a.step === 'ask') {
      var d = a.ask;
      if (d.reason === 'mismatch') {
        addText(s, 'The label reads ');
        addText(s, Mrp.format(d.value), true);
        addText(s, ', which is not in the reference list. Check the label, then tap what it shows.');
      } else if (d.reason === 'unconfirmed' && d.value != null) {
        addText(s, 'Best read ');
        addText(s, Mrp.format(d.value), true);
        addText(s, ', but it could not be confirmed. Check the label, then tap what it shows.');
      } else {
        addText(s, 'The MRP could not be read. Check the label, then tap what it shows.');
      }
    } else if (a.step === 'done') {
      var r = a.result;
      addText(s, Mrp.format(r.value), true);
      addText(s, r.how === 'label' ? ' — ' + (EVIDENCE[r.evidence] || 'checked on the label') + '.' : ' — confirmed by you.');
      if (r.refState === 'mrp-mismatch') addText(s, ' Flagged: not in the reference list.');
      else if (r.refState === 'barcode-unknown') addText(s, ' Flagged: barcode not in the reference list.');
    }
  }

  function renderChoices(a) {
    var box = el.auditChoices, d = a.ask, allowed = allowedFor(a.item) || [];
    while (box.firstChild) box.removeChild(box.firstChild);
    function add(label, sub, cls, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      if (sub) { var sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
      b.addEventListener('click', onClick);
      box.appendChild(b);
    }
    var guess = d.value;
    if (guess != null && !Mrp.inList(allowed, guess)) {
      add(Mrp.format(guess), allowed.length ? 'label · not in reference' : 'as read', 'flag', function () { record(a, guess, 'person'); });
    }
    allowed.forEach(function (v) {
      add(Mrp.format(v), 'in reference', guess != null && Math.abs(v - guess) < 0.005 ? 'suggested' : '',
        function () { record(a, v, 'person'); });
    });
    add('Other…', 'type it', 'ghost', function () {
      el.auditOther.hidden = false;
      el.auditOtherInput.value = '';
      el.auditOtherInput.focus();
    });
    add('Read again', 'camera', 'ghost', function () {
      a.step = 'mrp';
      a.frames = [];
      a.shot = '';
      a.photo = false;
      renderAuditCard();
      scheduleMrp(0);
    });
  }

  function saveOther(ev) {
    ev.preventDefault();
    var a = state.audit;
    var v = Reference.parseMrps(el.auditOtherInput.value)[0];
    if (a.step !== 'ask' || v == null) { el.auditOtherInput.focus(); return; }
    record(a, v, 'person');
  }

  /* ---------------- audit: results list + export ---------------- */

  function loadAudit() {
    try {
      var raw = window.localStorage.getItem(AUDIT_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) state.auditLines = parsed.filter(function (l) { return l && l.key && l.qty > 0; });
    } catch (e) { state.auditLines = []; }
  }

  function saveAudit() {
    try { window.localStorage.setItem(AUDIT_KEY, JSON.stringify(state.auditLines)); } catch (e) {}
  }

  var REF_STATE = {
    'match': 'matches reference',
    'mrp-mismatch': 'MRP NOT IN REFERENCE',
    'barcode-unknown': 'barcode not in reference',
    'no-reference': 'no reference list'
  };

  function renderAudit() {
    var list = el.auditList, units = 0;
    while (list.firstChild) list.removeChild(list.firstChild);
    state.auditLines.forEach(function (line) {
      units += line.qty;
      var li = document.createElement('li');
      var main = document.createElement('div');
      main.className = 'h-main';
      var val = document.createElement('div');
      val.className = 'h-val';
      val.textContent = line.name || line.code;
      var how = [];
      if (line.byLabel) how.push(line.byLabel + ' checked on label');
      if (line.byPerson) how.push(line.byPerson + ' confirmed by you');
      if (line.refState !== 'match') how.push(REF_STATE[line.refState]);
      var meta = document.createElement('div');
      meta.className = 'h-meta';
      meta.textContent = (line.name ? line.code + ' · ' : '') + how.join(' · ');
      main.appendChild(val);
      main.appendChild(meta);

      var chip = document.createElement('span');
      chip.className = 'mrp-chip' + (line.refState === 'match' ? '' : ' warn');
      chip.textContent = Mrp.format(line.mrp);
      var qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = '×' + line.qty;
      var minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'minus';
      minus.textContent = '−';
      minus.setAttribute('aria-label', 'Remove one unit of ' + (line.name || line.code));
      minus.addEventListener('click', function () {
        line.qty -= 1;
        if (line.byPerson) line.byPerson -= 1; else if (line.byLabel) line.byLabel -= 1;
        if (line.qty <= 0) state.auditLines.splice(state.auditLines.indexOf(line), 1);
        saveAudit();
        renderAudit();
      });

      li.appendChild(main);
      li.appendChild(chip);
      li.appendChild(qty);
      li.appendChild(minus);
      list.appendChild(li);
    });
    el.auditUnits.textContent = String(units);
    el.auditEmpty.hidden = state.auditLines.length > 0;
    el.auditExportBtn.hidden = state.auditLines.length === 0;
    el.auditClearBtn.hidden = state.auditLines.length === 0;
  }

  function stamp(ms, sep) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + (sep || ' ') +
      p(d.getHours()) + (sep ? '' : ':') + p(d.getMinutes()) + (sep ? '' : ':' + p(d.getSeconds()));
  }

  function exportAudit() {
    var rows = [['barcode', 'product', 'mrp', 'qty', 'mrp_check', 'checked_on_label', 'confirmed_by_person', 'first_scan', 'last_scan']];
    state.auditLines.slice().reverse().forEach(function (l) {
      rows.push([l.code, l.name || '', l.mrp.toFixed(2), l.qty, REF_STATE[l.refState] || '',
                 l.byLabel, l.byPerson, stamp(l.first), stamp(l.last)]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'audit-' + stamp(Date.now(), '-') + '.csv';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  function clearAudit() {
    var units = state.auditLines.reduce(function (s, l) { return s + l.qty; }, 0);
    if (!window.confirm('Clear all ' + units + ' audited units? Export first if you need them.')) return;
    state.auditLines = [];
    saveAudit();
    renderAudit();
  }

  /* ---------------- audit: reference list ---------------- */

  function renderRef() {
    var r = state.reference;
    if (r) {
      el.refTitle.textContent = r.items.size.toLocaleString() + ' products in the reference list';
      var when = '';
      try { when = new Date(r.importedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) {}
      el.refSub.textContent = (r.name || 'Imported list') + (when ? ' · imported ' + when : '');
      el.refImportBtn.textContent = 'Replace';
      el.refRemoveBtn.hidden = false;
    } else {
      el.refTitle.textContent = 'No reference list';
      el.refSub.textContent = 'Import a CSV with barcode and MRP columns from your stock system.';
      el.refImportBtn.textContent = 'Import CSV';
      el.refRemoveBtn.hidden = true;
    }
  }

  function importReference(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = Reference.fromCsv(String(reader.result)); }
      catch (e) { setNotice('Could not import ' + file.name + ': ' + e.message, 'warn'); return; }
      var ref = { name: file.name, importedAt: Date.now(), items: parsed.items };
      state.reference = ref;
      renderRef();
      var msg = 'Imported ' + ref.items.size.toLocaleString() + ' products from ' + file.name + '.';
      if (parsed.warnings.length) msg += ' ' + parsed.warnings.join(' ');
      setNotice(msg, parsed.warnings.length ? 'warn' : 'info');
      Reference.save(ref).catch(function () {
        setNotice('The reference list is loaded, but this browser would not store it — import it again after a reload.', 'warn');
      });
    };
    reader.onerror = function () { setNotice('Could not read ' + file.name + '.', 'warn'); };
    reader.readAsText(file);
  }

  function removeReference() {
    if (!window.confirm('Remove the reference list from this device?')) return;
    state.reference = null;
    renderRef();
    Reference.clear().catch(function () {});
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
    // Switching out of confirm mode must not leave the loop parked.
    if (state.mode !== 'confirm' && state.pending) { state.pending = null; resumeAfterConfirm(); }
    // Start the model download while barcodes are being scanned, not when the first MRP is due.
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
      el.startLabel.textContent = 'Start scanning';
      showCameraError(err);
    }).then(function () {
      state.starting = false;
      el.startBtn.disabled = false;
    });
  }

  function stop() {
    state.running = false;
    if (state.audit.item) auditReset();
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
    el.startLabel.textContent = 'Start scanning';
    el.torchBtn.disabled = true;
    el.torchBtn.classList.remove('active');
    el.flipBtn.disabled = true;
    el.zoomWrap.hidden = true;
    el.sessionChip.hidden = state.sessionCount === 0;
  }

  /* ---------------- wiring ---------------- */

  el.startBtn.addEventListener('click', function () {
    if (state.running) stop(); else start();
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

  el.auditCancel.addEventListener('click', auditReset);
  el.auditPickBtn.addEventListener('click', function () {
    var a = state.audit;
    if (a.step !== 'mrp') return;
    var guess = Mrp.bestGuess(a.frames);
    askPerson(a, { reason: guess == null ? 'unreadable' : 'unconfirmed', value: guess });
  });
  el.auditPhotoBtn.addEventListener('click', function () { el.auditPhoto.value = ''; el.auditPhoto.click(); });
  el.auditPhoto.addEventListener('change', function () { readPhoto(el.auditPhoto.files && el.auditPhoto.files[0]); });
  el.auditOther.addEventListener('submit', saveOther);
  el.refImportBtn.addEventListener('click', function () { el.refFile.value = ''; el.refFile.click(); });
  el.refFile.addEventListener('change', function () { importReference(el.refFile.files && el.refFile.files[0]); });
  el.refRemoveBtn.addEventListener('click', removeReference);
  el.auditExportBtn.addEventListener('click', exportAudit);
  el.auditClearBtn.addEventListener('click', clearAudit);

  // Tapping a non-blocking confirmation dismisses it early.
  el.confirm.addEventListener('click', function (ev) {
    if (state.paused) return;
    if (ev.target.closest && ev.target.closest('.confirm-value')) return;
    hideConfirm();
  });

  document.addEventListener('keydown', function (ev) {
    if (state.mode === 'audit') {
      if (ev.key === 'Escape' && state.audit.item && state.audit.step !== 'done') { ev.preventDefault(); auditReset(); }
      return;
    }
    if (!state.paused) return;
    if (ev.key === 'Enter') { ev.preventDefault(); keepPending(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); discardPending(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.running) {
      stop();
      setNotice('Camera released while the page was in the background. Tap Start scanning to resume.', 'info');
    }
  });

  window.addEventListener('pagehide', stop);

  try { setMode(window.localStorage.getItem(MODE_KEY) || 'auto'); } catch (e) { setMode('auto'); }
  loadHistory();
  renderHistory();
  loadAudit();
  renderAudit();
  renderRef();
  Reference.load().then(function (ref) {
    if (ref) { state.reference = ref; renderRef(); }
  }).catch(function () {});

  if (!secureEnough()) {
    setNotice('This page is not on a secure connection, so the browser will not grant camera access. Open it over https://.', 'warn');
  } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setNotice('This browser does not support camera access.', 'warn');
    el.startBtn.disabled = true;
  }

  el.engineBadge.textContent = (isAndroid && 'BarcodeDetector' in window) ? 'Native' : 'WASM';
})();
