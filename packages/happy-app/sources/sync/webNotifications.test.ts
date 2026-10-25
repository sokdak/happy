import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getWebNotificationPermission,
    requestWebNotificationPermission,
    showWebSessionNotification,
    subscribeWebNotificationClicks,
} from './webNotifications';

class BrowserNotification {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    static created: BrowserNotification[] = [];
    onclick: (() => void) | null = null;
    close = vi.fn();

    constructor(readonly title: string, readonly options: NotificationOptions) {
        BrowserNotification.created.push(this);
    }
}

const event = {
    type: 'session-event' as const,
    sessionId: 'session / 123',
    kind: 'done' as const,
    title: "It's ready!",
    body: 'Fix browser notifications',
    timestamp: 123,
};

beforeEach(() => {
    BrowserNotification.permission = 'default';
    BrowserNotification.created = [];
    BrowserNotification.requestPermission.mockClear();
    vi.stubGlobal('window', {
        isSecureContext: true,
        Notification: BrowserNotification,
        focus: vi.fn(),
    });
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: vi.fn(() => false) });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('browser notification permission', () => {
    it.each([
        ['default', 'undetermined', false, true],
        ['granted', 'granted', true, false],
        ['denied', 'denied', false, false],
    ] as const)('reports %s without prompting', (browserStatus, status, granted, canAskAgain) => {
        BrowserNotification.permission = browserStatus;
        expect(getWebNotificationPermission()).toEqual({ status, granted, canAskAgain });
        expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        { isSecureContext: false, Notification: BrowserNotification },
        { isSecureContext: true },
    ])('safely handles a missing or insecure browser API', async (browser) => {
        vi.stubGlobal('window', browser);
        expect(getWebNotificationPermission().status).toBe('unsupported');
        expect((await requestWebNotificationPermission()).granted).toBe(false);
        expect(() => showWebSessionNotification(event)).not.toThrow();
    });

    it('requests permission in the button call stack, before yielding the user gesture', async () => {
        const result = requestWebNotificationPermission();
        expect(BrowserNotification.requestPermission).toHaveBeenCalledOnce();
        expect(await result).toEqual({
            granted: true,
            openedSettings: false,
            permission: { status: 'granted', granted: true, canAskAgain: false },
        });
    });

    it.each(['granted', 'denied'] as const)('does not reprompt when already %s', async (permission) => {
        BrowserNotification.permission = permission;
        expect((await requestWebNotificationPermission()).permission.status).toBe(permission);
        expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
    });
});

describe('live session alerts', () => {
    it.each(['done', 'permission', 'question'] as const)('shows %s with the event copy', (kind) => {
        BrowserNotification.permission = 'granted';
        showWebSessionNotification({ ...event, kind });
        expect(BrowserNotification.created).toHaveLength(1);
        expect(BrowserNotification.created[0].title).toBe(event.title);
        expect(BrowserNotification.created[0].options).toEqual({
            body: event.body,
            tag: `happy-session:${event.sessionId}`,
        });
    });

    it('alerts for a visible but unfocused browser window', () => {
        BrowserNotification.permission = 'granted';
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false });
        showWebSessionNotification(event);
        expect(BrowserNotification.created).toHaveLength(1);
    });

    it('uses in-app indicators while Happy has focus', () => {
        BrowserNotification.permission = 'granted';
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
        showWebSessionNotification(event);
        expect(BrowserNotification.created).toHaveLength(0);
    });

    it.each(['default', 'denied'] as const)('does not notify or request permission when %s', (permission) => {
        BrowserNotification.permission = permission;
        showWebSessionNotification(event);
        expect(BrowserNotification.created).toHaveLength(0);
        expect(BrowserNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('focuses Happy and routes the original session ID on click; disposed listeners stay removed', () => {
        BrowserNotification.permission = 'granted';
        const navigate = vi.fn();
        const unsubscribe = subscribeWebNotificationClicks(navigate);
        try {
            showWebSessionNotification(event);
            const notification = BrowserNotification.created[0];
            notification.onclick?.();
            expect(window.focus).toHaveBeenCalledOnce();
            expect(notification.close).toHaveBeenCalledOnce();
            expect(navigate).toHaveBeenCalledExactlyOnceWith(event.sessionId);

            unsubscribe();
            notification.onclick?.();
            expect(navigate).toHaveBeenCalledOnce();
        } finally {
            unsubscribe();
        }
    });

    it('contains browser policy errors so they cannot break incoming updates', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        class BlockedNotification extends BrowserNotification {
            constructor(title: string, options: NotificationOptions) {
                super(title, options);
                throw new Error('Notifications blocked by browser policy');
            }
        }
        BrowserNotification.permission = 'granted';
        vi.stubGlobal('window', { isSecureContext: true, Notification: BlockedNotification });
        expect(() => showWebSessionNotification(event)).not.toThrow();
        expect(warn).toHaveBeenCalledOnce();
    });
});
