// Offline app shell: cache-first for static files, network refresh in the background.
const V = 'fukrong-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'analyze-worker.js', 'vendor/essentia-wasm.umd.js', 'vendor/essentia.js-core.umd.js', 'packs/dokmai.json', 'rmvpe-worker.js', 'ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'models/mel128.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && !k.startsWith('fukrong-models')).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.url.startsWith('blob:') || r.url.includes('/models/rmvpe')) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res && res.ok && (r.url.startsWith(self.location.origin) || r.url.includes('fonts.g'))) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
