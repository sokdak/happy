import { useEffect, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { trackOtaUpdateAvailable, trackOtaUpdateApplied } from '@/track';

/**
 * Whether an OTA check should run at all.
 *
 * `updatesEnabled` mirrors `Updates.isEnabled`, which follows the `updates`
 * block in app.config.js. Keeping the runtime as the source of truth means a
 * build with updates switched off never reaches out to the update server —
 * `checkForUpdateAsync()` rejects when expo-updates is disabled, so calling it
 * anyway would just log a failure on every foreground.
 */
export function shouldCheckForUpdates(params: {
    isDev: boolean;
    updatesEnabled: boolean;
    isChecking: boolean;
}): boolean {
    if (params.isDev) {
        return false;
    }
    if (!params.updatesEnabled) {
        return false;
    }
    if (params.isChecking) {
        return false;
    }
    return true;
}

type PendingOtaUpdate = {
    ota_version?: string;
    ota_runtime_version?: string;
};

export function useUpdates() {
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [pendingUpdate, setPendingUpdate] = useState<PendingOtaUpdate | null>(null);

    useEffect(() => {
        // Check for updates when app becomes active
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        // Initial check
        checkForUpdates();

        return () => {
            subscription.remove();
        };
    }, []);

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
        if (nextAppState === 'active') {
            checkForUpdates();
        }
    };

    const checkForUpdates = async () => {
        if (!shouldCheckForUpdates({
            isDev: __DEV__,
            updatesEnabled: Updates.isEnabled,
            isChecking,
        })) {
            return;
        }

        setIsChecking(true);

        try {
            const update = await Updates.checkForUpdateAsync();
            if (update.isAvailable) {
                const pendingUpdate = {
                    ota_version: update.manifest.id,
                    ota_runtime_version: 'runtimeVersion' in update.manifest ? update.manifest.runtimeVersion : undefined,
                };
                await Updates.fetchUpdateAsync();
                trackOtaUpdateAvailable(pendingUpdate);
                setPendingUpdate(pendingUpdate);
                setUpdateAvailable(true);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
        } finally {
            setIsChecking(false);
        }
    };

    const reloadApp = async () => {
        trackOtaUpdateApplied(pendingUpdate ?? undefined);
        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                console.error('Error reloading app:', error);
            }
        }
    };

    return {
        updateAvailable,
        isChecking,
        checkForUpdates,
        reloadApp,
    };
}
