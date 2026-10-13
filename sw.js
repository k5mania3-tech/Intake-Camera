// K AUCTION 입고조사 — service worker
// - Opens the app instantly from the phone, even with weak signal.
// - Keeps the Excel / OCR / PDF engines cached after first use.
// - Photos are never sent anywhere: they stay on the phone (IndexedDB).
// When a new index.html is deployed, it is fetched in the background and
// used from the next launch; the open app is told so it can show a notice.
const SHELL_CACHE = 'ka-intake-shell-v1';
const CDN_CACHE = 'ka-intake-cdn-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'tessdata.projectnaptha.com'];
const INDEX_URL = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Cache one by one so a single missing icon never blocks installation.
    await Promise.all(SHELL_FILES.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, CDN_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('ka-intake-') && !keep.includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function notifyUpdate() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'ka-update' }));
}

async function openApp(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(INDEX_URL);
  const cachedCopy = cached ? cached.clone() : null;
  const url = new URL(event.request.url);
  url.hash = '';
  const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(async (fetched) => {
    // A navigation must not be answered with a redirected response
    // (e.g. "/app" -> "/app/"), so keep a clean copy instead.
    const response = fetched.redirected
      ? new Response(await fetched.blob(), { status: fetched.status, statusText: fetched.statusText, headers: fetched.headers })
      : fetched;
    if (response.ok && response.type !== 'opaque') {
      const fresh = await response.clone().text();
      const previous = cachedCopy ? await cachedCopy.text() : null;
      await cache.put(INDEX_URL, response.clone());
      if (previous !== null && previous !== fresh) await notifyUpdate();
    }
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  try {
    return await network;
  } catch (error) {
    return (await cache.match(INDEX_URL)) || Response.error();
  }
}

async function sameOrigin(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  const network = fetch(event.request).then((response) => {
    if (response.ok) cache.put(event.request, response.clone()).catch(() => {});
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

async function cdnFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') event.respondWith(openApp(event));
    else if (!url.pathname.endsWith('/sw.js')) event.respondWith(sameOrigin(event));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cdnFirst(request));
});
