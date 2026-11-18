/* Service worker de la PWA: shell sin conexión, caché de estáticos y notificaciones Web Push.
 * Sin dependencias (no Workbox): es corto y así se entiende qué se cachea y qué no.
 * NUNCA se cachea el API (/api): carrito, sesión y pedidos son datos personales y vivos. */
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const MEDIA = `media-${VERSION}`;
const OFFLINE_URL = '/sin-conexion';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll([OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, STATIC, MEDIA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  // Páginas: red primero; sin conexión, la última versión vista o la página "sin conexión".
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !url.pathname.startsWith('/mi-cuenta') && !url.pathname.startsWith('/checkout')) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match(OFFLINE_URL))),
    );
    return;
  }

  // JS/CSS con hash en el nombre: inmutables, caché primero.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => cachePut(STATIC, req, res))));
    return;
  }

  // Fotos del catálogo: lo cacheado al instante y se actualiza por detrás.
  if (url.pathname.startsWith('/media/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(MEDIA).then(async (c) => {
        const hit = await c.match(req);
        const network = fetch(req)
          .then((res) => cachePut(MEDIA, req, res))
          .catch(() => hit);
        return hit || network;
      }),
    );
  }
});

function cachePut(name, req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(name).then((c) => c.put(req, copy));
  }
  return res;
}

// Web Push: el backend (Notificaciones, canal webpush) manda { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Moda Demo', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Moda Demo', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag,
      data: { url: data.url || '/mi-cuenta/pedidos' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  // Solo se abren páginas de la propia tienda.
  const href = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url === href && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(href);
    }),
  );
});
