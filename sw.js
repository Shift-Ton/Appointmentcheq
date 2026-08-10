/* Wadhwani Registration V10 service worker — install shell + notification handler */
const APP_VERSION = 'wadhwani-v10';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification?.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client && client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if ('navigate' in client) await client.navigate(targetUrl);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

/* Ready for a future server-side Web Push integration. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data?.text() || '' }; }
  const title = data.title || 'Wadhwani Registration';
  const options = {
    body: data.body || 'You have a Wadhwani registration reminder.',
    tag: data.tag || APP_VERSION,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    vibrate: [180, 120, 220],
    data: { url: data.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
