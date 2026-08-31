/* Barcode & QR scanner — rapid multi-scan, fully client-side.
 * Decoding: native BarcodeDetector when the browser has it, ZXing (vendored) otherwise. */
(function () {
  'use strict';

  var SCAN_INTERVAL_MS = 90;    // gap between decode attempts
  var MAX_EDGE = 960;           // downscale the cropped region to this before decoding
  var DUPE_WINDOW_MS = 1800;    // ignore the same value re-read within this window
  var RESUME_COOLDOWN_MS = 1200;// after keep/discard, suppress the same code this long
  var AUTO_CONFIRM_MS = 1100;   // how long the confirmation card stays up in rapid mode
  var MAX_HISTORY = 200;
  var HISTORY_KEY = 'scan.history.v1';
  var MODE_KEY = 'scan.mode.v1';

  function $(id) { return document.getElementById(id); }

  var el = {
    stage: $('stage'), video: $('video'), frame: $('frame'), flash: $('flash'),
    notice: $('notice'), engineBadge: $('engineBadge'),
    sessionChip: $('sessionChip'), sessionCount: $('sessionCount'),
    armed: $('armed'),
    confirm: $('confirm'), confirmCard: $('confirmCard'), confirmFormat: $('confirmFormat'),
    confirmIndex: $('confirmIndex'), confirmValue: $('confirmValue'),
    confirmActions: $('confirmActions'), keepBtn: $('keepBtn'), discardBtn: $('discardBtn'),
    startBtn: $('startBtn'), startLabel: $('startBtnLabel'),
    torchBtn: $('torchBtn'), flipBtn: $('flipBtn'),
    modeAuto: $('modeAuto'), modeConfirm: $('modeConfirm'),
    history: $('history'), historyCount: $('historyCount'),
    historyEmpty: $('historyEmpty'), clearBtn: $('clearBtn'), exportBtn: $('exportBtn')
  };

  var state = {
    running: false, starting: false, paused: false,
    stream: null, track: null,
    engine: null, detector: null, zxing: null, zxingHints: null,
    deviceIds: [], deviceIndex: 0,
    torchOn: false,
    mode: 'auto',
    sessionCount: 0,
    pending: null,
    lastValue: '', lastAt: 0,
    timer: null, confirmTimer: null,
    history: []
  };

  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var audioCtx = null;

  var FORMAT_NAMES = {
    QR_CODE: 'QR Code', DATA_MATRIX: 'Data Matrix', PDF_417: 'PDF417', PDF417: 'PDF417',
    AZTEC: 'Aztec', CODABAR: 'Codabar', CODE_39: 'Code 39', CODE_93: 'Code 93',
    CODE_128: 'Code 128', EAN_8: 'EAN-8', EAN_13: 'EAN-13', ITF: 'ITF',
    UPC_A: 'UPC-A', UPC_E: 'UPC-E', RSS_14: 'DataBar', RSS_EXPANDED: 'DataBar Expanded',
    DATABAR: 'DataBar', MAXICODE: 'MaxiCode', UPC_EAN_EXTENSION: 'UPC/EAN Ext',
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

  function setupEngine() {
    if (state.engine) return Promise.resolve();

    var native = Promise.resolve(null);
    if ('BarcodeDetector' in window && window.BarcodeDetector.getSupportedFormats) {
      native = window.BarcodeDetector.getSupportedFormats().catch(function () { return null; });
    }

    return native.then(function (formats) {
      if (formats && formats.length) {
        try {
          state.detector = new window.BarcodeDetector({ formats: formats });
          state.engine = 'native';
          el.engineBadge.textContent = 'Native';
          el.engineBadge.title = 'Using the built-in BarcodeDetector (' + formats.length + ' formats)';
          return;
        } catch (e) { /* fall through to ZXing */ }
      }
      return loadScript('vendor/zxing.min.js').then(function () {
        var Z = window.ZXing;
        var hints = new Map();
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
          Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.AZTEC,
          Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39,
          Z.BarcodeFormat.CODE_93, Z.BarcodeFormat.CODABAR, Z.BarcodeFormat.EAN_13,
          Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
          Z.BarcodeFormat.ITF, Z.BarcodeFormat.RSS_14
        ]);
        var reader = new Z.MultiFormatReader();
        reader.setHints(hints);
        state.zxing = reader;
        state.zxingHints = hints;
        state.engine = 'zxing';
        el.engineBadge.textContent = 'ZXing';
        el.engineBadge.title = 'Using the bundled ZXing decoder';
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
    var v = { width: { ideal: 1920 }, height: { ideal: 1080 } };
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
    }).then(refreshDevices).then(updateTorchButton);
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

  function captureRegion() {
    var v = el.video;
    if (!v.videoWidth || !v.videoHeight || v.readyState < 2) return false;

    var vr = v.getBoundingClientRect();
    var fr = el.frame.getBoundingClientRect();
    if (!vr.width || !fr.width) return false;

    // The video is object-fit: cover, so map the on-screen frame back to source pixels.
    var scale = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    var offX = (vr.width - v.videoWidth * scale) / 2;
    var offY = (vr.height - v.videoHeight * scale) / 2;

    var sx = (fr.left - vr.left - offX) / scale;
    var sy = (fr.top - vr.top - offY) / scale;
    var sw = fr.width / scale;
    var sh = fr.height / scale;

    sx = Math.max(0, Math.min(sx, v.videoWidth - 1));
    sy = Math.max(0, Math.min(sy, v.videoHeight - 1));
    sw = Math.max(1, Math.min(sw, v.videoWidth - sx));
    sh = Math.max(1, Math.min(sh, v.videoHeight - sy));

    var k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * k));
    canvas.height = Math.max(1, Math.round(sh * k));
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return true;
  }

  function scanTick() {
    if (!state.running || state.paused) return;
    if (!captureRegion()) { schedule(); return; }

    if (state.engine === 'native') {
      state.detector.detect(canvas).then(function (codes) {
        if (codes && codes.length) onCode(codes[0].rawValue, codes[0].format);
      }).catch(function () {}).then(function () { schedule(); });
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
    schedule();
  }

  function onCode(value, format) {
    if (value == null || value === '') return;
    var now = Date.now();
    if (value === state.lastValue && now - state.lastAt < DUPE_WINDOW_MS) {
      state.lastAt = now;
      return;
    }
    state.lastValue = value;
    state.lastAt = now;

    var entry = { value: value, format: prettyFormat(format), at: now };
    feedback();

    if (state.mode === 'confirm') {
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

  function feedback() {
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(950, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.15);
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

  /* ---------------- mode ---------------- */

  function setMode(mode) {
    state.mode = (mode === 'confirm') ? 'confirm' : 'auto';
    var isConfirm = state.mode === 'confirm';
    el.modeAuto.classList.toggle('is-on', !isConfirm);
    el.modeConfirm.classList.toggle('is-on', isConfirm);
    el.modeAuto.setAttribute('aria-pressed', String(!isConfirm));
    el.modeConfirm.setAttribute('aria-pressed', String(isConfirm));
    try { window.localStorage.setItem(MODE_KEY, state.mode); } catch (e) {}
    // Switching out of confirm mode must not leave the loop parked.
    if (!isConfirm && state.paused) { state.pending = null; resumeAfterConfirm(); }
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

  // Tapping a non-blocking confirmation dismisses it early.
  el.confirm.addEventListener('click', function (ev) {
    if (state.paused) return;
    if (ev.target.closest && ev.target.closest('.confirm-value')) return;
    hideConfirm();
  });

  document.addEventListener('keydown', function (ev) {
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

  if (!secureEnough()) {
    setNotice('This page is not on a secure connection, so the browser will not grant camera access. Open it over https://.', 'warn');
  } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setNotice('This browser does not support camera access.', 'warn');
    el.startBtn.disabled = true;
  }

  el.engineBadge.textContent = ('BarcodeDetector' in window) ? 'Native' : 'ZXing';
})();
