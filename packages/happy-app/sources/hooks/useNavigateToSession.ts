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

    // The template literal is repeated rather than hoisted into a variable on
    // purpose: typedRoutes needs the literal type, and assigning it to a
    // `const` first widens it to `string`, which is not assignable to `Href`.
    if (mode === 'replace') {
        // Session-to-session moves replace rather than push. Pushing left every
        // visited session screen mounted — with its ChatList and store
        // subscriptions — for the lifetime of the tab.
        router.replace(`/session/${encodeURIComponent(sessionId)}`);
        return;
    }
    router.push(`/session/${encodeURIComponent(sessionId)}`);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    return (sessionId: string) => {
        navigateToSession(router, sessionId, pathname);
    }
}
