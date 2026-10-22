import { describe, expect, it } from 'vitest';
import { shouldRefreshOnWebFocusTransition, type WebFocusState } from './webFocusRefresh';

describe('shouldRefreshOnWebFocusTransition', () => {
    it.each([
        ['background', 'active', true],
        ['active', 'active', false],
        ['active', 'background', false],
        ['background', 'background', false],
    ] as const)('%s -> %s refreshes: %s', (previousState, nextState, expected) => {
        expect(shouldRefreshOnWebFocusTransition(previousState, nextState)).toBe(expected);
    });

    it('coalesces visibility and focus notifications for one foreground edge', () => {
        let state: WebFocusState = 'background';
        let refreshes = 0;

        for (const nextState of ['active', 'active'] as const) {
            if (shouldRefreshOnWebFocusTransition(state, nextState)) {
                refreshes += 1;
            }
            state = nextState;
        }

        expect(refreshes).toBe(1);
    });
});
