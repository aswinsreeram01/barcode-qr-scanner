# Scan — Barcode & QR Reader

A single-page web app that uses your phone's camera to read barcodes and QR codes.
It is built for working through a *pile* of codes: every read is confirmed on screen and
the scanner immediately re-arms for the next one. No install, no backend, no uploads —
the video never leaves the device.

**Live:** https://aswinsreeram01.github.io/barcode-qr-scanner/

## Two scanning modes

| Mode | Behaviour |
| --- | --- |
| **Rapid** (default) | Each read is beeped, buzzed and shown on a confirmation card for about a second while scanning continues uninterrupted. Hold codes up back to back. |
| **Confirm each** | Scanning parks on each read and shows **Keep & next** / **Discard**. Tap (or press Enter / Esc) and it re-arms instantly. Use it when a mis-read would be expensive. |

Either way the same code will not be counted twice while it sits in front of the lens —
a short suppression window has to elapse, or a different code has to be read.

## Features

- Live camera scanning with an aligned crop region — only what is inside the frame is decoded
- Fast hybrid decoding: the ML Kit-backed native `BarcodeDetector` on Android (fed
  full-resolution frames straight from the video element), the zxing-cpp WebAssembly
  decoder everywhere else — including iOS Safari. Rotated, tilted and inverted codes
  read fine; a legacy JS decoder remains as a last-resort fallback
- Continuous autofocus is requested where the camera supports it
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

## Project layout

```
index.html              markup
css/styles.css          styles
js/app.js               camera, scan loop, decoding, confirmation flow, history
vendor/zxing-wasm/      zxing-wasm 2.2.4 (zxing-cpp WebAssembly reader) — main decoder
vendor/zxing.min.js     @zxing/library 0.21.3 UMD build (last-resort fallback)
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
