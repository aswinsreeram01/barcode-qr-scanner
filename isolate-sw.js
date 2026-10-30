/* Adds the headers that switch on cross-origin isolation, which multi-threaded
 * WebAssembly requires and static hosting such as GitHub Pages cannot send. It changes
 * headers only and stores nothing. Has to sit at the root to cover the whole app. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (ev) { ev.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  ev.respondWith(fetch(req).then(function (res) {
    if (res.status === 0) return res;
    var headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
  }));
});
