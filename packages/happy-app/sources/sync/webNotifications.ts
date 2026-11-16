import type { ApiEphemeralUpdate } from './apiTypes';
import type { PushPermissionInfo, PushPermissionRequestResult } from './pushRegistration';

type SessionEvent = Extract<ApiEphemeralUpdate, { type: 'session-event' }>;

const clickListeners = new Set<(sessionId: string) => void>();
let swMessageBound = false;

function notificationApi(): typeof Notification | null {
    if (typeof window === 'undefined' || !window.isSecureContext || typeof window.Notification !== 'function') {
        return null;
    }
    return window.Notification;
}

function serviceWorkerContainer(): ServiceWorkerContainer | null {
    if (
        typeof window === 'undefined' ||
        !window.isSecureContext ||
        '__TAURI_INTERNALS__' in window ||
        typeof navigator === 'undefined' ||
        !navigator.serviceWorker
    ) {
        return null;
    }
    return navigator.serviceWorker;
}

function onServiceWorkerMessage(event: MessageEvent): void {
    const data = event?.data;
    if (
        data &&
        typeof data === 'object' &&
        data.type === 'happy-session-notification-click' &&
        typeof data.sessionId === 'string' &&
        data.sessionId.length > 0
    ) {
        window.focus?.();
        for (const listener of clickListeners) {
            listener(data.sessionId);
        }
    }
}

export function registerWebServiceWorker(): void {
    const sw = serviceWorkerContainer();
    if (!sw || typeof sw.register !== 'function') {
        return;
    }
    sw.register('/sw.js').catch((error) => {
        console.warn('Failed to register service worker:', error);
    });
}

function permissionInfo(permission: NotificationPermission): PushPermissionInfo {
    return {
        status: permission === 'default' ? 'undetermined' : permission,
        granted: permission === 'granted',
        canAskAgain: permission === 'default',
    };
}

export function getWebNotificationPermission(): PushPermissionInfo {
    const api = notificationApi();
    return api ? permissionInfo(api.permission) : {
        status: 'unsupported',
        granted: false,
        canAskAgain: false,
    };
}

export async function requestWebNotificationPermission(): Promise<PushPermissionRequestResult> {
    const api = notificationApi();
    let permission = getWebNotificationPermission();
    if (api && permission.canAskAgain) {
        // Call before the first await: Safari requires the button's user gesture.
        permission = permissionInfo(await api.requestPermission());
    }
    return { granted: permission.granted, openedSettings: false, permission };
}

export function subscribeWebNotificationClicks(listener: (sessionId: string) => void): () => void {
    clickListeners.add(listener);
    const sw = serviceWorkerContainer();
    if (!swMessageBound && sw && typeof sw.addEventListener === 'function') {
        sw.addEventListener('message', onServiceWorkerMessage);
        swMessageBound = true;
    }
    return () => {
        clickListeners.delete(listener);
        if (clickListeners.size === 0 && swMessageBound) {
            const currentSw = serviceWorkerContainer();
            if (currentSw && typeof currentSw.removeEventListener === 'function') {
                currentSw.removeEventListener('message', onServiceWorkerMessage);
            }
            swMessageBound = false;
        }
    };
}

/** Uses the live session-event stream; no Expo token or background Web Push. */
export function showWebSessionNotification(event: SessionEvent): void {
    const api = notificationApi();
    if (!api || api.permission !== 'granted' || typeof document === 'undefined') {
        return;
    }
    if (document.visibilityState === 'visible' && document.hasFocus()) {
        return;
    }

    const tag = `happy-session:${event.sessionId}`;

    try {
        const notification = new api(event.title, {
            body: event.body,
            // Replace older alerts for this session, including in other tabs.
            tag,
        });
        notification.onclick = () => {
            notification.close();
            window.focus();
            for (const listener of clickListeners) {
                listener(event.sessionId);
            }
        };
    } catch (error) {
        // Android Chrome/PWA throws TypeError ("Illegal constructor") on `new Notification(...)`
        // and requires `ServiceWorkerRegistration.showNotification(...)` instead.
        const sw = serviceWorkerContainer();
        if (error instanceof TypeError && sw && typeof sw.getRegistration === 'function') {
            sw.getRegistration()
                .then((registration) => {
                    if (!registration) {
                        return;
                    }
                    return registration.showNotification(event.title, {
                        body: event.body,
                        tag,
                        icon: '/pwa-192x192.png',
                        data: { sessionId: event.sessionId },
                    });
                })
                .catch((swError) => {
                    console.warn('Failed to show service worker notification:', swError);
                });
            return;
        }
        // A browser/OS policy must not interrupt socket update processing.
        console.warn('Failed to show browser notification:', error);
    }
}
