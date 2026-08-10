import type {
    ActiveWorkflowPhaseSnapshot,
    ActiveWorkflowSnapshot,
} from '../../sync/storageTypes';

export type WorkflowVisualState = 'running' | 'completed' | 'error' | 'active';
export type WorkflowOpenTarget = 'context-panel' | 'route';
export type WorkflowPanelEvent =
    | { type: 'open' }
    | { type: 'close' }
    | { type: 'active-count'; count: number };

export interface WorkflowContextPanelOptions {
    ready: boolean;
    hasSession: boolean;
    width: number;
    platform: string;
    isMacDesktop: boolean;
}

export interface WorkflowContextPresentationOptions {
    openedWorkflowSessionId: string | null;
    sessionId: string;
    activeCount: number;
    canUseContextPanel: boolean;
    showFilesSidebar: boolean;
    zenMode: boolean;
}

export function selectActiveWorkflows(
    workflows: Record<string, ActiveWorkflowSnapshot> | null | undefined,
): ActiveWorkflowSnapshot[] {
    return Object.values(workflows ?? {}).sort((left, right) =>
        left.startedAt - right.startedAt || left.taskId.localeCompare(right.taskId),
    );
}

export function normalizeWorkflowAgentState(state: string): WorkflowVisualState {
    switch (state.toLowerCase()) {
        case 'start':
        case 'running':
        case 'in_progress':
            return 'running';
        case 'done':
        case 'completed':
        case 'success':
            return 'completed';
        case 'error':
        case 'failed':
            return 'error';
        default:
            return 'active';
    }
}

export function getPhaseVisualState(phase: ActiveWorkflowPhaseSnapshot): WorkflowVisualState {
    const states = phase.agents.map((agent) => normalizeWorkflowAgentState(agent.state));

    if (states.includes('running')) return 'running';
    if (states.includes('error')) return 'error';
    if (states.length > 0 && states.every((state) => state === 'completed')) return 'completed';
    return 'active';
}

export function getWorkflowBadgeModel(count: number): { count: number; plural: boolean } | null {
    return count > 0 ? { count, plural: count !== 1 } : null;
}

export function canUseWorkflowContextPanel(options: WorkflowContextPanelOptions): boolean {
    return options.ready
        && options.hasSession
        && options.width >= 1100
        && (options.platform === 'web' || options.isMacDesktop);
}

export function resolveWorkflowOpenTarget(
    canUseContextPanel: boolean,
    zenMode = false,
): WorkflowOpenTarget {
    return canUseContextPanel && !zenMode ? 'context-panel' : 'route';
}

export function getWorkflowContextPresentation(
    options: WorkflowContextPresentationOptions,
): {
    workflowPanelOpen: boolean;
    showWorkflowPanel: boolean;
    showContextPanel: boolean;
} {
    const workflowPanelOpen = options.openedWorkflowSessionId === options.sessionId
        && options.activeCount > 0;
    const showWorkflowPanel = options.canUseContextPanel
        && workflowPanelOpen
        && !options.zenMode;

    return {
        workflowPanelOpen,
        showWorkflowPanel,
        showContextPanel: showWorkflowPanel || options.showFilesSidebar,
    };
}

export function normalizeWorkflowSessionId(
    id: string | string[] | undefined,
): string | null {
    const value = Array.isArray(id) ? id[0] : id;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function reduceWorkflowPanelOpen(
    open: boolean,
    event: WorkflowPanelEvent,
): boolean {
    if (event.type === 'open') return true;
    if (event.type === 'close') return false;
    return event.count === 0 ? false : open;
}

export function shouldDismissWorkflowRoute(activeCount: number): boolean {
    return activeCount === 0;
}

export function formatWorkflowElapsed(startedAt: number, now: number): string {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(remainingSeconds).padStart(2, '0');

    return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${paddedMinutes}:${paddedSeconds}`;
}

export function formatWorkflowTokens(tokens: number): string {
    if (tokens < 1000) return String(Math.round(tokens));

    const thousands = Math.round((tokens / 1000) * 10) / 10;
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}
