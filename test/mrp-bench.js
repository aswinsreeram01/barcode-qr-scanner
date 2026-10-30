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
  // THREADS sets the reader's threads (the live site uses up to 4 where it can);
  // NO_EARLY=1 reads whole labels, for comparing against the early stop.
  const engine = await OcrCore.create(ort, {
    det: fs.readFileSync(path.join(vendor, 'det.onnx')),
    rec: fs.readFileSync(path.join(vendor, 'rec.onnx')),
    keys: fs.readFileSync(path.join(vendor, 'keys.txt'), 'utf8')
  }, { intraOpNumThreads: Number(process.env.THREADS || 1), interOpNumThreads: 1 });

  const files = fs.readdirSync(dir).filter(f => /^\d\d_.*MRP-[\d.]+\.jpe?g$/i.test(f)).sort();
  const totals = {};
  let wrong = 0, reads = 0, readMs = 0, products = 0, recognised = 0, found = 0;

  for (const f of files) {
    const truth = parseFloat(f.match(/MRP-([\d.]+)/)[1]);
    const crop = CROPS[f.slice(0, 2)];
    if (!crop) continue;
    const scenarios = { first: [], repeat: [truth], other: [Math.round(truth * 1.06)] };
    const row = [f.slice(0, 2).padEnd(3), String(truth).padEnd(5)];
    for (const [name, seen] of Object.entries(scenarios)) {
      const got = [];
      let d = { status: 'pending' };
      products++;
      for (let i = 0; i < Mrp.MAX_FRAMES && d.status === 'pending'; i++) {
        const plan = Mrp.nextAttempt(got);
        const img = await frameImage(path.join(dir, f), crop, i);
        const opts = Object.assign({}, plan, process.env.NO_EARLY ? {} : { enough: Mrp.stopRule(seen, plan.quick) });
        const res = await engine.read(img, opts);
        reads++; readMs += res.ms.total; recognised += res.recognised; found += res.boxes;
        const a = Mrp.assess(res.lines, seen);
        a.skew = res.skew; a.flip = plan.flip;
        got.push(a);
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
  console.log(`one read: ${Math.round(readMs / reads)} ms, ${(recognised / reads).toFixed(1)} of ${(found / reads).toFixed(1)} lines read. Per product: ${Math.round(readMs / products)} ms over ${(reads / products).toFixed(1)} reads`);
})().catch(e => { console.error(e); process.exit(1); });
