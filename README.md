# Scan — Barcode & QR Reader

A single-page web app that uses your phone's camera to read barcodes and QR codes.
It is built for working through a *pile* of codes: every read is confirmed on screen and
the scanner immediately re-arms for the next one. **Audit** mode also reads the MRP off
each product's label and checks it against your stock reference list. No install, no
backend, no uploads — the video never leaves the device.

**Live:** https://aswinsreeram01.github.io/barcode-qr-scanner/

## Scanning modes

| Mode | Behaviour |
| --- | --- |
| **Rapid** (default) | Each read is beeped, buzzed and shown on a confirmation card for about a second while scanning continues uninterrupted. Hold codes up back to back. |
| **Confirm each** | Scanning parks on each read and shows **Keep & next** / **Discard**. Tap (or press Enter / Esc) and it re-arms instantly. Use it when a mis-read would be expensive. |
| **Audit** | For stock audits and receiving: scan the barcode, then show the MRP label. Each unit is recorded with its MRP and how that MRP was checked. See below. |

In every mode the same code will not be counted twice while it sits in front of the lens —
a short suppression window has to elapse, or a different code has to be read.

## Audit mode: barcode + MRP

1. **Import the reference list** — a CSV export from the stock system listing every
   barcode and the MRPs valid for it. It is stored on the device (IndexedDB) and stays
   until replaced or removed.
2. **Scan the barcode.** The card shows the product and its expected MRPs.
3. **Show the MRP label** inside the frame (turn the pack if the MRP is on another face).
   The label is read on the device and the unit is recorded.

### When an MRP is accepted automatically

The app never saves a guessed MRP. A reading is accepted without a tap only when it
**matches the reference list** *and* something independent backs it up:

- **the label's own USP line** — Indian labels print a unit sale price and net quantity
  (`USP ₹4.40 per ml` … `Net Vol 750ml`), and USP × quantity must equal the MRP; or
- **two separate camera frames** read the same value with every digit at ≥ 90 %
  confidence. Not used when two reference MRPs for the barcode differ by a single digit
  (₹3,300 / ₹3,380) — then only the USP line can settle it.

Everything else goes to the person, with the label photo, the best reading and the
reference MRPs as one-tap buttons:

| Situation | What happens |
| --- | --- |
| Label MRP is **not** in the reference list | Never auto-accepted. The card says what the label reads; the person taps the label value (recorded and flagged **MRP NOT IN REFERENCE**) or a reference value. |
| Reading not confirmed after 5 frames | Best reading pre-highlighted; tap it, another MRP, or type it. |
| Barcode not in the reference list | MRP can only be auto-accepted via the USP line; the line is flagged. |
| Label hard to read live | **Photo** uses the phone's own camera app (sharper focus); **Choose MRP** skips straight to the buttons. |

Every audit line records `checked_on_label` and `confirmed_by_person` counts, so the
export shows how each unit's MRP was established. **Export CSV** downloads
`barcode, product, mrp, qty, mrp_check, checked_on_label, confirmed_by_person,
first_scan, last_scan`; **−** on a line removes one unit.

### Reference CSV format

```csv
barcode,product,mrp
0691027644058,Shea Conditioner 750ml,3300
0691027646175,Shea Hair Mask 500ml,3480 | 3280
8904059147216,Ayurvedic Tablets 60s,140
```

- Columns are found by header name: `barcode` (or `ean` / `gtin` / `upc` / `code`), `mrp`
  (or `price`), and optionally `product` / `name`. Comma, semicolon or tab separated.
- Several MRPs for one barcode: separate them with `|`, `;` or `/` in one cell, or repeat
  the barcode on several rows. `3,300` is read as one price.
- Leading zeros do not matter: `0691027644058`, `691027644058` and `00691027644058` match.
- If Excel has turned barcodes into `6.91E+11`, the import says so — format the column
  as Text and export again.

### The MRP reader

PaddleOCR (PP-OCRv4) text detection and recognition models running on ONNX Runtime Web
in a Web Worker. The label's angle is measured from the text lines themselves, so tilted
and sideways labels are straightened without needing a barcode in view. The ~27 MB of
model and runtime files download once and are then kept in the browser's Cache Storage,
so later visits and offline use skip the download. One reading takes about 1–3 s on a
desktop browser; expect longer on a phone.

## Features

- Live camera scanning with an aligned crop region — only what is inside the frame is decoded
- Fast hybrid decoding: the ML Kit-backed native `BarcodeDetector` on Android (fed
  full-resolution frames straight from the video element), the zxing-cpp WebAssembly
  decoder everywhere else — including iOS Safari. Rotated, tilted and inverted codes
  read fine; a legacy JS decoder remains as a last-resort fallback
- Continuous autofocus is requested where the camera supports it
- **Zoom slider** (defaults to 2x, remembered between sessions) — the right way to read
  small or distant codes is to zoom in from 20-30 cm out, where autofocus actually
  works, not to move the phone closer into its macro blind zone
- **Tap the preview to refocus** on that spot (where the camera exposes it)
- On Android, if the native detector goes 3 s without a read the wasm decoder is
  pulled in and interleaved as a backup
- Running count for the current session, plus a persistent scan list
- Tap any row to copy it, or **Copy all** to grab the whole list in scan order
- Flashlight toggle and camera switching, where the hardware supports it
- Beep, vibrate and a screen flash on every successful read
- Works offline once loaded, and installs to the home screen

## Supported symbologies

QR Code, Data Matrix, Aztec, PDF417, Code 128, Code 39, Code 93, Codabar, ITF,
EAN-8, EAN-13, UPC-A, UPC-E, GS1 DataBar.

The exact set depends on the engine: native `BarcodeDetector` advertises its own list
(Android Chrome covers all the common ones); the wasm decoder covers the list above plus
Micro QR, rMQR and DataBar Limited. The badge in the top-right shows which engine is
running — Native, WASM, or ZXing JS.

## Scanning tips

- Hold the phone 20-30 cm away and use the zoom slider — do not move closer than the
  camera can focus.
- Tap the preview to force a refocus if the image stays soft.
- Use the flashlight button on glossy or dim codes.

## Requirements

- **HTTPS is mandatory.** Browsers only expose `getUserMedia` on secure origins.
  GitHub Pages serves HTTPS, so the live URL works; plain `http://` will not.
- Camera permission has to be granted when the browser prompts. If it was denied once,
  re-enable it in the site settings for the page.
- Backgrounding the page releases the camera; tap **Start scanning** to resume.

## Running locally

Any static file server over `localhost` works (localhost counts as a secure origin):

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. To test from a real phone on your LAN you need HTTPS,
so use the deployed GitHub Pages URL or a tunnel such as `cloudflared`/`ngrok`.
The server must send `.mjs` files as JavaScript and `.wasm` as `application/wasm` for the
MRP reader to load.

## Testing the MRP reader

`test/mrp-bench.js` runs the app's own `js/ocr-core.js` and `js/mrp.js` on sample label
photos in Node, the way the live flow does (several frames per product, each framed a
little differently), against three reference situations: the label's MRP is listed, it
is not listed (must never auto-accept), and the barcode is unknown.

```bash
cd test && npm install && npm run bench
```

Photos go in `samples/` (not committed), named `NN_description_MRP-<amount>.jpg`; the
`CROPS` table in the script says where the label sits in each photo.

## Project layout

```
index.html              markup
css/styles.css          styles
js/app.js               camera, scan loop, decoding, confirmation flow, history, audit flow
js/mrp.js               MRP parsing, USP cross-check and the accept-or-ask rules
js/reference.js         reference CSV import, barcode normalising, on-device storage
js/ocr-core.js          text reader: angle estimate, straightening, PaddleOCR detect + recognise
js/ocr-worker.js        runs the text reader in a Web Worker, caches the models
vendor/zxing-wasm/      zxing-wasm 2.2.4 (zxing-cpp WebAssembly reader) — main decoder
vendor/zxing.min.js     @zxing/library 0.21.3 UMD build (last-resort fallback)
vendor/onnxruntime-web/ ONNX Runtime Web 1.22.0, wasm build
vendor/paddleocr/       PP-OCRv4 detection + recognition models (ONNX) and dictionary
test/                   Node benchmark for the MRP reader
icon.svg                app icon
manifest.webmanifest    PWA manifest
.nojekyll               tells GitHub Pages to serve the files as-is
```

## Deployment

Pushing to `main` publishes automatically — GitHub Pages serves the repository root of
that branch. There is no build step.

## Licence

MIT for the application code. `vendor/zxing-wasm/` is
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (MIT, wrapping Apache-2.0
[zxing-cpp](https://github.com/zxing-cpp/zxing-cpp)); `vendor/zxing.min.js` is
[@zxing/library](https://github.com/zxing-js/library), Apache-2.0.
`vendor/onnxruntime-web/` is [ONNX Runtime](https://github.com/microsoft/onnxruntime), MIT;
`vendor/paddleocr/` holds [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) models,
Apache-2.0.
