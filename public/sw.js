const CACHE_NAME = 'ghostchat-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css?v=6',
  '/i18n.js?v=2',
  '/script.js?v=3',
  '/manifest.webmanifest',
  '/icons/ghostchat-192.png',
  '/icons/ghostchat-512.png',
  '/socket.io/socket.io.js',
];

const CACHED_PATHS = new Set([
  '/',
  '/index.html',
  '/style.css',
  '/i18n.js',
  '/script.js',
  '/manifest.webmanifest',
  '/icons/ghostchat-192.png',
  '/icons/ghostchat-512.png',
  '/socket.io/socket.io.js',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !CACHED_PATHS.has(url.pathname)
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseCopy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy));
        }
        return response;
      });
    }),
  );
});
