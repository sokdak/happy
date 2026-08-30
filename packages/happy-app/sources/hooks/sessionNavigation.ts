export type SessionNavigationMode = 'push' | 'replace' | 'noop';

const SESSION_PATH_PREFIX = '/session/';
const STATIC_SESSION_CHILD_ROUTES = new Set(['recent']);

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // A malformed route should only cause a redundant navigation, never
        // prevent the requested session from opening.
        return segment;
    }
}

/**
 * Avoid retaining every visited chat screen in the navigation stack.
 * Browse surfaces still push so the user can return to them normally.
 */
export function resolveSessionNavigation(
    currentPathname: string,
    targetSessionId: string,
): SessionNavigationMode {
    if (!currentPathname.startsWith(SESSION_PATH_PREFIX)) {
        return 'push';
    }

    const rest = currentPathname.slice(SESSION_PATH_PREFIX.length);
    if (!rest) {
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
