/* Runs the app's own OCR + MRP rules on sample photos, the way the live audit flow does:
 * several camera frames per product, each framed slightly differently.
 *
 *   cd test && npm install && node mrp-bench.js ../samples
 *
 * Sample files are named NN_description_MRP-<amount>.jpg; CROPS below says where the
 * label sits in each photo (what the on-screen frame would cover). Each sample is scored
 * as the first unit of its barcode, as a repeat unit (its price already counted), and
 * with a different price already counted (which must not attract the reading). */
'use strict';
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const OcrCore = require('../js/ocr-core.js');
const Mrp = require('../js/mrp.js');

const dir = process.argv[2] || path.join(__dirname, '..', 'samples');
const vendor = path.join(__dirname, '..', 'vendor', 'paddleocr');

const CROPS = {
  '01': [80, 930, 700, 290], '02': [200, 670, 400, 330], '03': [100, 700, 500, 240],
  '04': [80, 630, 800, 330], '05': [130, 430, 360, 680], '06': [70, 690, 550, 430],
  '07': [200, 500, 610, 360], '08': [940, 2600, 1040, 680]
};
const MAX_EDGE = 1280;  // same downscale the app applies to the captured frame

// Consecutive camera frames never line up exactly: drawn frame, looser, nudged, drawn.
function framing([x, y, w, h], i, W, H) {
  const f = [[0, 0, 1], [-0.12, -0.12, 1.24], [0.05, 0.05, 1], [0, 0, 1]][i % 4];
  const nx = Math.max(0, Math.round(x + w * f[0])), ny = Math.max(0, Math.round(y + h * f[1]));
  return [nx, ny, Math.min(W - nx, Math.round(w * f[2])), Math.min(H - ny, Math.round(h * f[2]))];
}

async function frameImage(file, crop, i) {
  const meta = await sharp(file).metadata();
  const [x, y, w, h] = framing(crop, i, meta.width, meta.height);
  const k = Math.min(1, MAX_EDGE / Math.max(w, h));
  const { data, info } = await sharp(file).extract({ left: x, top: y, width: w, height: h })
    .resize(Math.round(w * k), Math.round(h * k)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

(async () => {
  const engine = await OcrCore.create(ort, {
    det: fs.readFileSync(path.join(vendor, 'det.onnx')),
    rec: fs.readFileSync(path.join(vendor, 'rec.onnx')),
    keys: fs.readFileSync(path.join(vendor, 'keys.txt'), 'utf8')
  });

  const files = fs.readdirSync(dir).filter(f => /^\d\d_.*MRP-[\d.]+\.jpe?g$/i.test(f)).sort();
  const totals = {};
  let wrong = 0, reads = 0, readMs = 0;

  for (const f of files) {
    const truth = parseFloat(f.match(/MRP-([\d.]+)/)[1]);
    const crop = CROPS[f.slice(0, 2)];
    if (!crop) continue;
    // OCR each frame once; how a frame is straightened does not depend on `seen`.
    const frames = [];
    for (let i = 0; i < Mrp.MAX_FRAMES; i++) {
      const plan = Mrp.nextAttempt(frames);
      const img = await frameImage(path.join(dir, f), crop, i);
      const res = await engine.read(img, plan);
      reads++; readMs += res.ms.total;
      const a = Mrp.assess(res.lines, []);
      frames.push({ lines: res.lines, found: a.found, skew: res.skew, flip: plan.flip });
    }
    if (process.env.DUMP) frames.forEach((fr, i) => console.log(`  [${f.slice(0, 2)} f${i} skew ${fr.skew}${fr.flip ? ' flip' : ''}]`,
      fr.lines.map(l => `${l.text} {${l.mean.toFixed(2)}}`).join(' | ')));

    const scenarios = { first: [], repeat: [truth], other: [Math.round(truth * 1.06)] };
    const row = [f.slice(0, 2).padEnd(3), String(truth).padEnd(5)];
    for (const [name, seen] of Object.entries(scenarios)) {
      const got = [];
      let d = { status: 'pending' };
      for (let i = 0; i < frames.length && d.status === 'pending'; i++) {
        got.push(Mrp.assess(frames[i].lines, seen));
        d = Mrp.decide(got, seen);
      }
      const right = d.value === truth;
      let label;
      if (d.status === 'accepted') {
        if (!right) wrong++;
        label = `${right ? 'OK' : 'WRONG!'} ${d.value} (${d.evidence}, ${got.length}f)`;
      } else {
        label = `${d.status} ${d.value == null ? '—' : d.value}${right ? '✓' : ''} (${got.length}f)`;
      }
      const k = d.status === 'accepted' ? (right ? 'accepted right' : 'ACCEPTED WRONG') : d.status + (right ? ' (guess right)' : '');
      totals[name] = totals[name] || {};
      totals[name][k] = (totals[name][k] || 0) + 1;
      row.push(`${name}: ${label}`.padEnd(38));
    }
    console.log(row.join(' '));
  }
  console.log('\nby scenario:', JSON.stringify(totals));
  console.log(`wrong prices auto-accepted: ${wrong}`);
  console.log(`OCR reads: ${reads}, average ${Math.round(readMs / reads)} ms each (this machine, native ONNX Runtime)`);
})().catch(e => { console.error(e); process.exit(1); });
