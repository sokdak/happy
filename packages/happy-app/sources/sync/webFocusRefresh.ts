export type WebFocusState = 'active' | 'background';

/**
 * Web can report the same foregrounding through both visibilitychange and
 * focus (and React Native Web may report it through AppState as well). Refresh
 * only on the actual background -> active edge so one refocus produces one
 * message/git-status refresh.
 */
export function shouldRefreshOnWebFocusTransition(
    previousState: WebFocusState,
    nextState: WebFocusState,
): boolean {
    return previousState === 'background' && nextState === 'active';
}
