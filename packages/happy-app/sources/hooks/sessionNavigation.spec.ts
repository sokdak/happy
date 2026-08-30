import { describe, expect, it } from 'vitest';
import { resolveSessionNavigation } from './sessionNavigation';

describe('resolveSessionNavigation', () => {
    it.each(['/', '/settings', '', '/session/', '/session/recent'])(
        'pushes from browse route %s',
        (pathname) => {
            expect(resolveSessionNavigation(pathname, 'session-a')).toBe('push');
        },
    );

    it('replaces a different session chat', () => {
        expect(resolveSessionNavigation('/session/session-b', 'session-a')).toBe('replace');
    });

    it('does nothing when the requested session chat is already open', () => {
        expect(resolveSessionNavigation('/session/session-a', 'session-a')).toBe('noop');
    });

    it.each(['/session/session-b/info', '/session/session-a/files'])(
        'replaces from session sub-route %s',
        (pathname) => {
            expect(resolveSessionNavigation(pathname, 'session-a')).toBe('replace');
        },
    );

    it('recognizes a percent-encoded session id', () => {
        expect(resolveSessionNavigation('/session/a%2Fb', 'a/b')).toBe('noop');
    });

    it('handles malformed percent-encoding conservatively', () => {
        expect(resolveSessionNavigation('/session/%E0%A4%A', 'session-a')).toBe('replace');
    });
});
