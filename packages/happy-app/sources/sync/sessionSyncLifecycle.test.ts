import { describe, expect, it, vi } from 'vitest';
import { resolveExistingViewingSessionId, stopDeletedSessionWork } from './sessionSyncLifecycle';

describe('resolveExistingViewingSessionId', () => {
    it('returns the viewed session while it still exists', () => {
        expect(resolveExistingViewingSessionId({
            currentViewingSessionId: 'session-a',
            sessions: { 'session-a': {} },
        })).toBe('session-a');
    });

    it('rejects a stale viewed-session id after deletion', () => {
        expect(resolveExistingViewingSessionId({
            currentViewingSessionId: 'session-a',
            sessions: {},
        })).toBeNull();
    });

    it('rejects an absent viewed-session id', () => {
        expect(resolveExistingViewingSessionId({
            currentViewingSessionId: null,
            sessions: { 'session-a': {} },
        })).toBeNull();
    });
});

describe('stopDeletedSessionWork', () => {
    it('stops retry loops and aborts the in-flight send before dropping them', () => {
        const messageSync = { stop: vi.fn() };
        const sendSync = { stop: vi.fn() };
        const controller = { abort: vi.fn() };
        const registries = {
            messagesSync: new Map([['session-a', messageSync]]),
            sendSync: new Map([['session-a', sendSync]]),
            sendAbortControllers: new Map([['session-a', controller]]),
            pendingOutbox: new Map([['session-a', [{ localId: 'pending' }]]]),
        };

        stopDeletedSessionWork('session-a', registries);

        expect(messageSync.stop).toHaveBeenCalledOnce();
        expect(sendSync.stop).toHaveBeenCalledOnce();
        expect(controller.abort).toHaveBeenCalledOnce();
        expect(registries.messagesSync.has('session-a')).toBe(false);
        expect(registries.sendSync.has('session-a')).toBe(false);
        expect(registries.sendAbortControllers.has('session-a')).toBe(false);
        expect(registries.pendingOutbox.has('session-a')).toBe(false);
    });

    it('does not disturb another session during the delete race', () => {
        const otherSync = { stop: vi.fn() };
        const registries = {
            messagesSync: new Map([['session-b', otherSync]]),
            sendSync: new Map([['session-b', otherSync]]),
            sendAbortControllers: new Map([['session-b', { abort: vi.fn() }]]),
            pendingOutbox: new Map([['session-b', ['pending']]]),
        };

        stopDeletedSessionWork('session-a', registries);

        expect(otherSync.stop).not.toHaveBeenCalled();
        expect(registries.messagesSync.has('session-b')).toBe(true);
        expect(registries.sendSync.has('session-b')).toBe(true);
        expect(registries.sendAbortControllers.has('session-b')).toBe(true);
        expect(registries.pendingOutbox.has('session-b')).toBe(true);
    });
});
