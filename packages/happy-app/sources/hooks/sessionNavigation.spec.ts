import { describe, expect, it } from 'vitest';
import { resolveSessionNavigation } from './sessionNavigation';

describe('resolveSessionNavigation', () => {
    it('pushes from the home screen', () => {
        expect(resolveSessionNavigation('/', 'session-a')).toBe('push');
    });

    it('pushes from an unrelated screen', () => {
        expect(resolveSessionNavigation('/settings', 'session-a')).toBe('push');
    });

    it('pushes from the recent list so back still returns to it', () => {
        expect(resolveSessionNavigation('/session/recent', 'session-a')).toBe('push');
    });

    it('pushes for a bare /session/ path', () => {
        expect(resolveSessionNavigation('/session/', 'session-a')).toBe('push');
    });

    it('pushes for an empty pathname', () => {
        expect(resolveSessionNavigation('', 'session-a')).toBe('push');
    });

    it('replaces when switching to a different session', () => {
        expect(resolveSessionNavigation('/session/session-b', 'session-a')).toBe('replace');
    });

    it('is a no-op when already on the target session chat', () => {
        expect(resolveSessionNavigation('/session/session-a', 'session-a')).toBe('noop');
    });

    it('replaces from a different session sub-route', () => {
        expect(resolveSessionNavigation('/session/session-b/info', 'session-a')).toBe('replace');
    });

    it('replaces from the target session own sub-route', () => {
        expect(resolveSessionNavigation('/session/session-a/info', 'session-a')).toBe('replace');
    });

    it('treats a percent-encoded id as the same session', () => {
        expect(resolveSessionNavigation('/session/a%2Fb', 'a/b')).toBe('noop');
    });

    it('does not throw on malformed percent-encoding', () => {
        expect(resolveSessionNavigation('/session/%E0%A4%A', 'session-a')).toBe('replace');
    });
});
