import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Platform: { OS: 'android' },
}));

vi.mock('expo-updates', () => ({
    isEnabled: false,
    checkForUpdateAsync: vi.fn(),
    fetchUpdateAsync: vi.fn(),
    reloadAsync: vi.fn(),
}));

vi.mock('@/track', () => ({
    trackOtaUpdateAvailable: vi.fn(),
    trackOtaUpdateApplied: vi.fn(),
}));

import { shouldCheckForUpdates } from './useUpdates';

describe('shouldCheckForUpdates', () => {
    it('does not check when the updates runtime is disabled', () => {
        const result = shouldCheckForUpdates({
            isDev: false,
            updatesEnabled: false,
            isChecking: false,
        });

        expect(result).toBe(false);
    });

    it('does not check in development builds', () => {
        const result = shouldCheckForUpdates({
            isDev: true,
            updatesEnabled: true,
            isChecking: false,
        });

        expect(result).toBe(false);
    });

    it('does not start a second check while one is in flight', () => {
        const result = shouldCheckForUpdates({
            isDev: false,
            updatesEnabled: true,
            isChecking: true,
        });

        expect(result).toBe(false);
    });

    it('checks when enabled, out of dev, and idle', () => {
        const result = shouldCheckForUpdates({
            isDev: false,
            updatesEnabled: true,
            isChecking: false,
        });

        expect(result).toBe(true);
    });
});
