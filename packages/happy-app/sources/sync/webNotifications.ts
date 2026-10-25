import type { ApiEphemeralUpdate } from './apiTypes';
import type { PushPermissionInfo, PushPermissionRequestResult } from './pushRegistration';

type SessionEvent = Extract<ApiEphemeralUpdate, { type: 'session-event' }>;

const clickListeners = new Set<(sessionId: string) => void>();

function notificationApi(): typeof Notification | null {
    if (typeof window === 'undefined' || !window.isSecureContext || typeof window.Notification !== 'function') {
        return null;
    }
    return window.Notification;
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
    return () => {
        clickListeners.delete(listener);
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

    try {
        const notification = new api(event.title, {
            body: event.body,
            // Replace older alerts for this session, including in other tabs.
            tag: `happy-session:${event.sessionId}`,
        });
        notification.onclick = () => {
            notification.close();
            window.focus();
            for (const listener of clickListeners) {
                listener(event.sessionId);
            }
        };
    } catch (error) {
        // A browser/OS policy must not interrupt socket update processing.
        console.warn('Failed to show browser notification:', error);
    }
}
