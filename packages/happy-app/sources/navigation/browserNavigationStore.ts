import { create } from 'zustand';
import {
    applyRouteHistoryPathname,
    createRouteHistory,
    PendingRouteAction,
    RouteHistoryState,
} from './browserNavigation';

interface BrowserNavigationState {
    routeHistory: RouteHistoryState | null;
    pendingRouteAction: PendingRouteAction;
    syncRoutePathname: (pathname: string) => void;
    markRouteBack: () => void;
    markRouteForward: () => void;
    markRouteReplace: () => void;
}

export const useBrowserNavigationStore = create<BrowserNavigationState>((set) => ({
    routeHistory: null,
    pendingRouteAction: null,
    syncRoutePathname: (pathname) => set((state) => ({
        routeHistory: state.routeHistory
            ? applyRouteHistoryPathname(state.routeHistory, pathname, state.pendingRouteAction)
            : createRouteHistory(pathname),
        pendingRouteAction: null,
    })),
    markRouteBack: () => set({ pendingRouteAction: 'back' }),
    markRouteForward: () => set({ pendingRouteAction: 'forward' }),
    markRouteReplace: () => set({ pendingRouteAction: 'replace' }),
}));
