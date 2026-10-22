/**
 * Pure decision logic for the session header's action affordances.
 *
 * The phone header exposes session actions through the avatar button that opens the
 * session-info screen. Desktop and web have no such affordance, which leaves actions
 * like "Duplicate from message…" (rewind) reachable only through undiscoverable paths.
 * This predicate decides when the desktop overflow entry point should be rendered.
 */

export interface DesktopSessionActionsVisibility {
    /** Whether the session has finished loading and can back the action list. */
    hasSession: boolean;
    /** `Platform.OS` of the current runtime. */
    platformOS: string;
    /** Result of `isRunningOnMac()` — true for the macOS desktop build. */
    runningOnMac: boolean;
}

/**
 * Returns true when the chat header should render the desktop overflow ("…") button
 * that opens the session actions popover.
 */
export function shouldShowDesktopSessionActions({
    hasSession,
    platformOS,
    runningOnMac,
}: DesktopSessionActionsVisibility): boolean {
    if (!hasSession) {
        return false;
    }
    return platformOS === 'web' || runningOnMac;
}
