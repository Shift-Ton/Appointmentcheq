/* Wadhwani Registration V21 service worker — Vercel proxy UI shell */
const APP_VERSION = 'wadhwani-v24-vercel-proxy';
const SHELL_CACHE = `${APP_VERSION}-shell`;
const APP_SHELL = [
  './',
  './index.html',
  './script.js?v=23',
  './style.css?v=23',
  './favicon.svg?v=1',
  './vendor/bootstrap/bootstrap.min.css?v=5.3.3',
  './vendor/bootstrap/bootstrap.bundle.min.js?v=5.3.3',
  './vendor/bootstrap-icons/bootstrap-icons.min.css?v=1.11.3',
  './vendor/bootstrap-icons/fonts/bootstrap-icons.woff2?dd67030699838ea613ee6dbda90effa6',
  './vendor/qrcode/qrcode.min.js?v=1'
];
let firebaseMessagingReady = false;

try {
  importScripts('./firebase-config.js');
  const pushConfig = self.WADHWANI_FIREBASE || null;
  if (pushConfig?.enabled && pushConfig.config?.projectId && pushConfig.config?.messagingSenderId && pushConfig.config?.appId) {
    const sdkVersion = pushConfig.sdkVersion || '12.17.1';
    importScripts(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-app-compat.js`);
    importScripts(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-messaging-compat.js`);
    firebase.initializeApp(pushConfig.config);
    const messaging = firebase.messaging();
    firebaseMessagingReady = true;

    messaging.onBackgroundMessage(payload => {
      const data = payload?.data || {};
      const title = data.title || payload?.notification?.title || 'Wadhwani Registration';
      const body = data.body || payload?.notification?.body || 'You have a Wadhwani registration reminder.';
      const type = data.type || 'reminder';
      const url = data.url || `./?push=${encodeURIComponent(type)}`;
      const tag = data.tag || `${APP_VERSION}-${type}`;

      return self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        requireInteraction: type === 'call',
        vibrate: type === 'call' ? [250, 120, 320, 120, 420] : [180, 120, 220],
        data: {
          url,
          type,
          queueNumber: data.queueNumber || '',
          studentIdNumber: data.studentIdNumber || ''
        }
      });
    });
  }
} catch (error) {
  console.warn('Wadhwani Firebase background messaging is not configured yet:', error?.message || error);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const targets = APP_SHELL;
    await Promise.allSettled(targets.map(async target => {
      const request = new Request(target, {
        cache: 'reload',
        mode: 'same-origin'
      });
      const response = await fetch(request);
      if (response && response.ok) await cache.put(request, response.clone());
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('wadhwani-v') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

/* Network-first keeps deployments fresh. Cached files are used only when the network fails. */
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isLocal = url.origin === self.location.origin;
  if (!isLocal) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cacheKey = new Request(url.href);
    try {
      const response = await fetch(request);
      const shouldCache = !['/sw.js', '/firebase-config.js'].includes(url.pathname);
      if (shouldCache && response && (response.ok || response.type === 'opaque')) {
        try { await cache.put(cacheKey, response.clone()); } catch (_) { /* keep the live response even when a response cannot be cached */ }
      }
      return response;
    } catch (_) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html') || await cache.match('./');
        if (shell) return shell;
      }
      return new Response('Offline resource unavailable.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification?.data || {};
  const targetUrl = new URL(data.url || './', self.registration.scope).href;

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

/* If Firebase is not configured, no closed-app remote push can be received.
 * The foreground/local 10-minute alarm in script.js continues to work. */
self.addEventListener('message', event => {
  if (event.data?.type === 'WADHWANI_PUSH_STATUS' && event.source?.postMessage) {
    event.source.postMessage({
      type: 'WADHWANI_PUSH_STATUS_RESULT',
      firebaseMessagingReady,
      appVersion: APP_VERSION
    });
  }
});
