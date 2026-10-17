const CACHE_NAME = 'meshpay-shell-v5';
const HTML_REFERENCE_PATTERN = /(?:src|href)="([^\"]+)"/g;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error('Unable to fetch the application shell for offline caching.');
    const html = await response.clone().text();
    const references = [...html.matchAll(HTML_REFERENCE_PATTERN)]
      .map((match) => match[1])
      .filter((reference) => reference.startsWith('/') && !reference.startsWith('/api/'));
    const cache = await caches.open(CACHE_NAME);
    await cache.put('/', response);
    await cache.addAll([...new Set(['/icon.svg', ...references])]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put('/', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    const refresh = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || refresh;
  }));
});
