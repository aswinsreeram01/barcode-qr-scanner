# Scan — Barcode & QR Reader

A single-page web app that uses your phone's camera to read barcodes and QR codes.
It is built for working through a *pile* of codes: every read is confirmed on screen and
the scanner immediately re-arms for the next one. **Audit** mode counts stock by barcode +
price, reading the MRP off each label, and exports the counts to Excel. No install, no
backend, no uploads — the video never leaves the device.

**Live:** https://aswinsreeram01.github.io/barcode-qr-scanner/

## Scanning modes

| Mode | Behaviour |
| --- | --- |
| **Rapid** (default) | Each read is beeped, buzzed and shown on a confirmation card for about a second while scanning continues uninterrupted. Hold codes up back to back. |
| **Confirm each** | Scanning parks on each read and shows **Keep & next** / **Discard**. Tap (or press Enter / Esc) and it re-arms instantly. Use it when a mis-read would be expensive. |
| **Audit** | For stock audits and receiving: start an audit, scan every unit's barcode and price, end it, and download the counts as an Excel file. See below. |

In every mode the same code will not be counted twice while it sits in front of the lens —
a short suppression window has to elapse, or a different code has to be read.

## Audit mode: barcode + MRP

A product is its **barcode + price**: the same barcode at two prices is two products.
Every scan is one unit of a product, and the audit ends with a count for each.

1. **Start new audit.** The camera starts. An audit in progress survives a reload.
2. **Scan each unit.** Barcode first, then the price:
   - both in one view counts as **one scan**;
   - otherwise it is **two scans**: the barcode is held on screen for as long as it takes
     to bring the MRP into the frame.
3. **End audit** downloads `audit-<date>-<time>.xlsx`. The list then locks; **Download
   Excel** fetches the file again until a new audit starts. The file has three sheets:
   - **Audit**: `Barcode`, `MRP` and `Count`, the result of the audit;
   - **Scans**: every unit with the time its barcode was read, the time it was counted,
     how long that took and how long each read took;
   - **Device**: audit start and end, reader threads, CPU cores and browser.

Send the file along when reporting a slow or wrong scan: the Scans and Device sheets show
what happened on the phone. Nothing is sent anywhere by the app itself.

### Telling you what needs a rescan

Scanning never gets stuck, and nothing is counted without a price.

| Situation | What happens |
| --- | --- |
| No barcode read for 8 s | A hint says to hold it flat, zoom or use the flash. |
| The same barcode is still in view | It is not counted again, and a hint says to take it out of view to count another. |
| No price found | "Price not recognised". Reading continues, so bringing the MRP into the frame is the rescan. **Type price** enters it by hand. |
| A price read but not confirmed | Shown with **Use ₹…** and **Type price**; reading continues meanwhile. |
| Wrong barcode | **Rescan barcode** starts that product again. |

### When a price counts by itself

A reading is counted without a tap when one of these backs it up:

- **the label's USP line**: Indian labels print a unit sale price and net quantity
  (`USP ₹4.40 per ml` … `Net Vol 750ml`), and USP × quantity should equal the MRP;
- **a price already counted** for this barcode in this audit, which also makes further
  units of a product quicker; or
- **two camera frames** reading the same value.

A reading the label's USP line contradicts needs the USP check or a person. The ₹ sign is
often read as a leading digit (`₹3,300` → `53,300`). The digit is dropped when the USP
line or an already-counted price names the shorter number, or when no ₹ was read and the
reader doubts that digit.

There is no reference list yet, so a reading that passes these checks can still be wrong.
Checking counts and prices against the stock database is planned as phase 2.

### Correcting mistakes

- **Edit price** or **Undo** on the "Counted" card, for about 3 seconds after each unit.
- Tap a price in the list to change it for that whole row; rows with the same barcode and
  price merge.
- **−** and **+** on a row adjust its count by hand.

### The price reader

PaddleOCR (PP-OCRv4) text detection and recognition models running on ONNX Runtime Web
in a Web Worker. The label's angle is measured from the text lines themselves, so tilted
and sideways labels are straightened without needing a barcode in view. The ~27 MB of
model and runtime files download once and are then kept in the browser's Cache Storage,
so later visits and offline use skip the download.

Two things keep it quick:

- **It stops early.** Text lines are read from the bottom of the label up, and reading
  stops once the price lines are in hand. Labels with the MRP near the top gain less.
- **It uses up to 4 threads.** Threads need cross-origin isolation, which GitHub Pages
  cannot switch on, so `isolate-sw.js` adds the headers and the first visit reloads
  itself once. It changes headers only and stores nothing. Without support the reader
  runs on one thread.

A read takes under a second in a desktop browser; expect longer on a phone.

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
little differently). Each photo is scored as the first unit of its barcode, as a repeat
unit, and with a different price already counted, which must not attract the reading.

```bash
cd test && npm install && npm run bench
```

Set `NO_EARLY=1` to read whole labels and `THREADS=4` to use several threads, for comparing
timings.

Photos go in `samples/` (not committed), named `NN_description_MRP-<amount>.jpg`; the
`CROPS` table in the script says where the label sits in each photo.

## Project layout

```
index.html              markup
css/styles.css          styles
js/app.js               camera, scan loop, decoding, confirmation flow, history, audit
js/mrp.js               MRP parsing, USP cross-check and the rules for counting a reading
js/xlsx.js              writes the audit's Excel file
js/ocr-core.js          text reader: angle estimate, straightening, PaddleOCR detect + recognise
js/ocr-worker.js        runs the text reader in a Web Worker, caches the models
js/isolate.js           registers isolate-sw.js, which the reader's threads depend on
isolate-sw.js           service worker adding the cross-origin isolation headers
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
