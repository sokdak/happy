import { describe, expect, it } from 'vitest';
import { shouldShowDesktopSessionActions } from './sessionHeaderActions';

describe('shouldShowDesktopSessionActions', () => {
    it('shows the overflow entry point on web', () => {
        expect(shouldShowDesktopSessionActions({
            hasSession: true,
            platformOS: 'web',
            runningOnMac: false,
        })).toBe(true);
    });

    it('shows the overflow entry point on the macOS desktop build', () => {
        expect(shouldShowDesktopSessionActions({
            hasSession: true,
            platformOS: 'ios',
            runningOnMac: true,
        })).toBe(true);
    });

    it('hides the overflow entry point on phones and tablets', () => {
        expect(shouldShowDesktopSessionActions({
            hasSession: true,
            platformOS: 'ios',
            runningOnMac: false,
        })).toBe(false);
        expect(shouldShowDesktopSessionActions({
            hasSession: true,
            platformOS: 'android',
            runningOnMac: false,
        })).toBe(false);
    });

    it('hides the overflow entry point until the session is loaded', () => {
        expect(shouldShowDesktopSessionActions({
            hasSession: false,
            platformOS: 'web',
            runningOnMac: false,
        })).toBe(false);
        expect(shouldShowDesktopSessionActions({
            hasSession: false,
            platformOS: 'ios',
            runningOnMac: true,
        })).toBe(false);
    });
});
