/* Wadhwani Registration V14 service worker — browser notifications + Firebase background push */
const APP_VERSION = 'wadhwani-v14-premium-ticket';
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

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

/* Pass requests through to the network. The service worker is used only for browser notifications; it does not make the site an install-required app and does not cache Google Sheets data. */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
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
