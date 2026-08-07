/**
 * Pure navigation-mode decisions for opening a session.
 *
 * Deliberately free of imports so it can be unit-tested without mocking
 * expo-router, the sync store, or analytics.
 */

export type SessionNavigationMode = 'push' | 'replace' | 'noop';

const SESSION_PATH_PREFIX = '/session/';

/**
 * Routes that live under /session/ but are not session ids.
 * `/session/recent` is app/(app)/session/recent.tsx — a browse surface, so we
 * push over it and leave its back behaviour exactly as it is today.
 */
const STATIC_SESSION_CHILD_ROUTES = new Set(['recent']);

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // Malformed percent-encoding: compare the raw segment instead. Worst
        // case is a redundant replace, never a lost navigation.
        return segment;
    }
}

export function resolveSessionNavigation(
    currentPathname: string,
    targetSessionId: string,
): SessionNavigationMode {
    if (!currentPathname.startsWith(SESSION_PATH_PREFIX)) {
        return 'push';
    }

    const rest = currentPathname.slice(SESSION_PATH_PREFIX.length);
    if (rest.length === 0) {
        return 'push';
    }

    const slashIndex = rest.indexOf('/');
    const hasSubRoute = slashIndex !== -1;
    const sessionSegment = hasSubRoute ? rest.slice(0, slashIndex) : rest;

    if (!hasSubRoute && STATIC_SESSION_CHILD_ROUTES.has(sessionSegment)) {
        return 'push';
    }

    if (!hasSubRoute && decodeSegment(sessionSegment) === targetSessionId) {
        return 'noop';
    }

    return 'replace';
}
