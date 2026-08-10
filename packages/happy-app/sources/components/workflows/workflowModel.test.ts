import { describe, expect, it } from 'vitest';
import type { ActiveWorkflowSnapshot } from '../../sync/storageTypes';
import {
    canUseWorkflowContextPanel,
    formatWorkflowElapsed,
    formatWorkflowTokens,
    getPhaseVisualState,
    getWorkflowContextPresentation,
    getWorkflowBadgeModel,
    normalizeWorkflowSessionId,
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

    it('keeps a mixed completed and in-progress phase running while preserving unknown agent states', () => {
        expect(getPhaseVisualState({ index: 0, title: 'Mixed', agents: [
            { id: '1', index: 0, label: 'Completed', state: 'completed' },
            { id: '2', index: 1, label: 'In progress', state: 'in_progress' },
        ] })).toBe('running');
        expect(normalizeWorkflowAgentState('provider-added-state')).toBe('active');
    });

    it('builds badge models only for active workflows', () => {
        expect(getWorkflowBadgeModel(0)).toBeNull();
        expect(getWorkflowBadgeModel(1)).toEqual({ count: 1, plural: false });
        expect(getWorkflowBadgeModel(3)).toEqual({ count: 3, plural: true });
    });

    it('uses the context panel only for eligible wide web or mac desktop sessions', () => {
        const webWide = canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'web', isMacDesktop: false });
        const macDesktopWide = canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'ios', isMacDesktop: true });

        expect(webWide).toBe(true);
        expect(macDesktopWide).toBe(true);
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 900, platform: 'web', isMacDesktop: false })).toBe(false);
        expect(canUseWorkflowContextPanel({ ready: true, hasSession: true, width: 1200, platform: 'ios', isMacDesktop: false })).toBe(false);
        expect(resolveWorkflowOpenTarget(webWide)).toBe('context-panel');
        expect(resolveWorkflowOpenTarget(macDesktopWide)).toBe('context-panel');
        expect(resolveWorkflowOpenTarget(false)).toBe('route');
        expect(resolveWorkflowOpenTarget(webWide, true)).toBe('route');
    });

    it('binds an open workflow monitor to the session where it was opened', () => {
        expect(getWorkflowContextPresentation({
            openedWorkflowSessionId: 'session-a',
            sessionId: 'session-b',
            activeCount: 1,
            canUseContextPanel: true,
            showFilesSidebar: true,
            zenMode: false,
        })).toEqual({
            workflowPanelOpen: false,
            showWorkflowPanel: false,
            showContextPanel: true,
            filesSidebarInteractionEnabled: true,
        });
    });

    it('restores Files immediately when the final workflow is removed', () => {
        expect(getWorkflowContextPresentation({
            openedWorkflowSessionId: 'session-a',
            sessionId: 'session-a',
            activeCount: 0,
            canUseContextPanel: true,
            showFilesSidebar: true,
            zenMode: false,
        })).toEqual({
            workflowPanelOpen: false,
            showWorkflowPanel: false,
            showContextPanel: true,
            filesSidebarInteractionEnabled: true,
        });
    });

    it('does not auto-open a later workflow run', () => {
        expect(getWorkflowContextPresentation({
            openedWorkflowSessionId: null,
            sessionId: 'session-a',
            activeCount: 1,
            canUseContextPanel: true,
            showFilesSidebar: true,
            zenMode: false,
        }).showWorkflowPanel).toBe(false);
    });

    it('resumes an already-open context panel after temporary zen mode', () => {
        const options = {
            openedWorkflowSessionId: 'session-a',
            sessionId: 'session-a',
            activeCount: 1,
            canUseContextPanel: true,
            showFilesSidebar: false,
        };

        expect(getWorkflowContextPresentation({ ...options, zenMode: true })).toEqual({
            workflowPanelOpen: true,
            showWorkflowPanel: false,
            showContextPanel: false,
            filesSidebarInteractionEnabled: false,
        });
        expect(getWorkflowContextPresentation({ ...options, zenMode: false })).toMatchObject({
            showWorkflowPanel: true,
            filesSidebarInteractionEnabled: false,
        });
    });

    it('normalizes route session ids without constructing invalid hrefs', () => {
        expect(normalizeWorkflowSessionId('session-a')).toBe('session-a');
        expect(normalizeWorkflowSessionId(['session-a', 'session-b'])).toBe('session-a');
        expect(normalizeWorkflowSessionId([])).toBeNull();
        expect(normalizeWorkflowSessionId('')).toBeNull();
        expect(normalizeWorkflowSessionId(undefined)).toBeNull();
    });

    it('opens and closes the panel only from explicit events or zero active workflows', () => {
        expect(reduceWorkflowPanelOpen(false, { type: 'active-count', count: 3 })).toBe(false);
        expect(reduceWorkflowPanelOpen(true, { type: 'active-count', count: 3 })).toBe(true);
        expect(reduceWorkflowPanelOpen(false, { type: 'open' })).toBe(true);
        expect(reduceWorkflowPanelOpen(true, { type: 'close' })).toBe(false);
        expect(reduceWorkflowPanelOpen(true, { type: 'active-count', count: 0 })).toBe(false);
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
