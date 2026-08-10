import { describe, expect, it } from 'vitest';
import type { ActiveWorkflowSnapshot } from '../../sync/storageTypes';
import {
    canUseWorkflowContextPanel,
    formatWorkflowElapsed,
    formatWorkflowTokens,
    getPhaseVisualState,
    getWorkflowBadgeModel,
    normalizeWorkflowAgentState,
    reduceWorkflowPanelOpen,
    resolveWorkflowOpenTarget,
    selectActiveWorkflows,
    shouldDismissWorkflowRoute,
} from './workflowModel';

function workflow(taskId: string, startedAt: number): ActiveWorkflowSnapshot {
    return {
        taskId,
        name: `Workflow ${taskId}`,
        startedAt,
        updatedAt: startedAt,
        phases: [],
    };
}

describe('workflowModel', () => {
    it('sorts active workflows by oldest start time then task id', () => {
        const selected = selectActiveWorkflows({
            c: workflow('c', 200),
            b: workflow('b', 100),
            a: workflow('a', 100),
        });

        expect(selected.map((item) => item.taskId)).toEqual(['a', 'b', 'c']);
    });

    it.each([
        ['start', 'running'],
        ['RUNNING', 'running'],
        ['in_progress', 'running'],
        ['done', 'completed'],
        ['completed', 'completed'],
        ['success', 'completed'],
        ['error', 'error'],
        ['failed', 'error'],
        ['future-state', 'active'],
    ] as const)('normalizes %s to %s', (state, expected) => {
        expect(normalizeWorkflowAgentState(state)).toBe(expected);
    });

    it('derives phase state with running, error, and completion priority', () => {
        expect(getPhaseVisualState({ index: 0, title: 'Empty', agents: [] })).toBe('active');
        expect(getPhaseVisualState({ index: 0, title: 'Running', agents: [
            { id: '1', index: 0, label: 'One', state: 'failed' },
            { id: '2', index: 1, label: 'Two', state: 'running' },
        ] })).toBe('running');
        expect(getPhaseVisualState({ index: 0, title: 'Error', agents: [
            { id: '1', index: 0, label: 'One', state: 'failed' },
        ] })).toBe('error');
        expect(getPhaseVisualState({ index: 0, title: 'Done', agents: [
            { id: '1', index: 0, label: 'One', state: 'done' },
        ] })).toBe('completed');
    });

    it('builds badge models only for active workflows', () => {
        expect(getWorkflowBadgeModel(0)).toBeNull();
        expect(getWorkflowBadgeModel(1)).toEqual({ count: 1, plural: false });
        expect(getWorkflowBadgeModel(3)).toEqual({ count: 3, plural: true });
    });

    it('uses the context panel only for eligible wide web or mac desktop sessions', () => {
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'web', isMacDesktop: false })).toBe(true);
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'ios', isMacDesktop: true })).toBe(true);
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 900, platform: 'web', isMacDesktop: false })).toBe(false);
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'ios', isMacDesktop: false })).toBe(false);
        expect(resolveWorkflowOpenTarget({ ready: true, hasSession: true, width: 1200, platform: 'web', isMacDesktop: false })).toBe('context-panel');
        expect(resolveWorkflowOpenTarget({ ready: true, hasSession: true, width: 1200, platform: 'ios', isMacDesktop: true })).toBe('context-panel');
        expect(resolveWorkflowOpenTarget({ ready: true, hasSession: true, width: 900, platform: 'web', isMacDesktop: false })).toBe('route');
    });

    it('opens and closes the panel only from explicit events or zero active workflows', () => {
        expect(reduceWorkflowPanelOpen(false, 'active-count', 3)).toBe(false);
        expect(reduceWorkflowPanelOpen(true, 'active-count', 3)).toBe(true);
        expect(reduceWorkflowPanelOpen(false, 'open', 3)).toBe(true);
        expect(reduceWorkflowPanelOpen(true, 'close', 3)).toBe(false);
        expect(reduceWorkflowPanelOpen(true, 'active-count', 0)).toBe(false);
        expect(shouldDismissWorkflowRoute(0)).toBe(true);
        expect(shouldDismissWorkflowRoute(1)).toBe(false);
    });

    it('formats elapsed time and tokens deterministically', () => {
        expect(formatWorkflowElapsed(1000, 19000)).toBe('00:18');
        expect(formatWorkflowElapsed(1000, 3662000)).toBe('1:01:01');
        expect(formatWorkflowElapsed(19000, 1000)).toBe('00:00');
        expect(formatWorkflowTokens(999)).toBe('999');
        expect(formatWorkflowTokens(24600)).toBe('24.6k');
    });
});
