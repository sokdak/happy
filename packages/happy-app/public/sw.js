// Minimal service worker for standalone PWA installation and Android notifications.
// Deliberately avoids intercepting fetch so web bundles and API traffic never serve stale cache.

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const sessionId = event.notification.data && event.notification.data.sessionId;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if ('focus' in client) {
                    return client.focus().then((focused) => {
                        const target = focused || client;
                        if (sessionId) {
                            target.postMessage({
                                type: 'happy-session-notification-click',
                                sessionId,
                            });
                        }
                    });
                }
            }
            if (self.clients.openWindow) {
                const path = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/';
                return self.clients.openWindow(path);
            }
        }),
    );
});
