// Service worker voor Hitster Party.
// Doel: installeerbaar maken en de app-schil snel laden.
// Het spel zelf heeft altijd internet nodig (Socket.IO, iTunes, Spotify), dus die
// verzoeken laten we ongemoeid.
const CACHE = 'hitster-shell-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Alleen eigen GET-verzoeken; Socket.IO, Spotify en iTunes gaan direct naar het netwerk
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io/')) return;

  // De pagina zelf: eerst netwerk (dan krijg je altijd de nieuwste versie), anders de cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (url.search === '') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Iconen en manifest: eerst cache
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
