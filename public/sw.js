// Service Worker för Asken Online PWA
const CACHE_NAME = 'asken-v1';

// Filer att cacha för offline-användning
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manual.html',
  '/about.html',
  '/manifest.json',
  '/gfx/favicon.ico',
  '/gfx/web-app-manifest-192x192.png',
  '/gfx/web-app-manifest-512x512.png',
  '/gfx/open_graph.jpg',
  '/gfx/logo.webp',
  '/gfx/bg_wood.webp',
  '/gfx/bg_dark_steel.webp',
  '/gfx/card_back.webp'
];

// Installera Service Worker och cacha statiska filer
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        // Cacha filer en i taget för att hantera eventuella 404:or
        return Promise.allSettled(
          STATIC_ASSETS.map(url => 
            cache.add(url).catch(err => console.log(`[SW] Failed to cache ${url}:`, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Aktivera och rensa gamla caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Hantera fetch-requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skippa WebSocket-anslutningar och API-anrop
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }
  
  // Skippa socket.io och stats/health endpoints
  if (url.pathname.startsWith('/socket.io') || 
      url.pathname === '/stats' || 
      url.pathname === '/health') {
    return;
  }
  
  event.respondWith(
    // Network first, fallback to cache
    fetch(event.request)
      .then((response) => {
        // Cacha lyckade GET-requests
        if (event.request.method === 'GET' && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => {
        // Om nätverket misslyckas, försök med cache
        return caches.match(event.request)
          .then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            
            // Om det är en navigation, visa offline-sidan (index.html)
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            
            return new Response('Offline', { status: 503 });
          });
      })
  );
});

// Lyssna på meddelanden från klienten
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
