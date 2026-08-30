import type { Router } from "expo-router"
import { usePathname, useRouter } from "expo-router"
import * as React from 'react';
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { resolveSessionNavigation } from './sessionNavigation';

export function navigateToSession(router: Router, sessionId: string, currentPathname: string) {
    const mode = resolveSessionNavigation(currentPathname, sessionId);
    if (mode === 'noop') {
        return;
    }

    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    if (mode === 'replace') {
        useBrowserNavigationStore.getState().markRouteReplace();
        router.replace(`/session/${encodeURIComponent(sessionId)}`);
        return;
    }
    router.push(`/session/${encodeURIComponent(sessionId)}`);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    return React.useCallback((sessionId: string) => {
        navigateToSession(router, sessionId, pathname);
    }, [pathname, router]);
}
