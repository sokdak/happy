import type { Router } from "expo-router"
import { usePathname, useRouter } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';
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

    const href = `/session/${encodeURIComponent(sessionId)}`;
    if (mode === 'replace') {
        // Session-to-session moves replace rather than push. Pushing left every
        // visited session screen mounted — with its ChatList and store
        // subscriptions — for the lifetime of the tab.
        router.replace(href);
        return;
    }
    router.push(href);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    return (sessionId: string) => {
        navigateToSession(router, sessionId, pathname);
    }
}
