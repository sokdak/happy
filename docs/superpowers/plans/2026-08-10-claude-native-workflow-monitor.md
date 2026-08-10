# Claude Native Workflow Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Claude Code native `local_workflow` tasks and show only their live workflow → phase → agent → current-tool hierarchy through an explicit badge-opened monitor on web, desktop, and mobile.

**Architecture:** `happy-cli` observes Claude `system` messages before the frozen session-message mapper drops them, reduces them into an active-only snapshot, and publishes that snapshot through encrypted `AgentState`. `happy-app` parses that optional field independently, derives a stable display model, and renders a conditional header badge plus either an ephemeral right context panel or a mobile/narrow-web route; terminal events remove state and close the surface immediately.

**Tech Stack:** TypeScript 5.9, Vitest, Zod 4, React 19, React Native/Expo Router, React Native Reanimated, existing encrypted `ApiSessionClient.updateAgentState` synchronization.

---

## File map

### CLI

- Create `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.ts` — pure native-workflow reducer plus the 250 ms coalescing publisher.
- Create `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.test.ts` — sanitized Claude Code 2.1.220 lifecycle fixtures, reducer tests, and fake-timer publisher tests.
- Modify `packages/happy-cli/src/api/types.ts` — shared encrypted `ActiveWorkflowSnapshot` and nested snapshot types.
- Modify `packages/happy-cli/src/api/apiSession.ts` — feed Claude system messages to the tracker before transcript mapping, merge snapshots into agent state, and expose runtime reset/disposal methods.
- Modify `packages/happy-cli/src/api/apiSession.test.ts` — prove system messages update encrypted agent state even though they produce no chat envelopes.
- Modify `packages/happy-cli/src/claude/claudeLocalLauncher.ts` and `packages/happy-cli/src/claude/claudeLocalLauncher.test.ts` — clear stale workflow state at local runtime boundaries.
- Modify `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` — clear stale workflow state at remote SDK runtime boundaries.

### App

- Modify `packages/happy-app/sources/sync/storageTypes.ts` and `packages/happy-app/sources/sync/storageTypes.spec.ts` — independently parse valid workflow entries while preserving the rest of `AgentState` when optional workflow data is malformed.
- Create `packages/happy-app/sources/components/workflows/workflowModel.ts` — stable ordering, provider-state normalization, phase state, elapsed/usage formatting, responsive target selection, and ephemeral panel reducer.
- Create `packages/happy-app/sources/components/workflows/workflowModel.test.ts` — pure Node tests for all UI decisions that do not require a `.tsx` renderer.
- Create `packages/happy-app/sources/components/workflows/WorkflowActivityBadge.tsx` — count badge with pulse and accessible label.
- Create `packages/happy-app/sources/components/workflows/WorkflowPanel.tsx` — shared workflow/phase/agent/current-tool hierarchy used by desktop and mobile.
- Modify `packages/happy-app/sources/-session/SessionView.tsx` — header entry point, temporary right-panel selection, resize behavior, immediate auto-close, and Files-panel restoration.
- Create `packages/happy-app/sources/app/(app)/session/[id]/workflows.tsx` — full-screen mobile/narrow-web monitor that returns to chat as soon as the active set is empty.
- Modify `packages/happy-app/sources/app/(app)/_layout.tsx` — register the workflows route.
- Modify `packages/happy-app/sources/components/tools/knownTools.tsx` and `packages/happy-app/sources/components/tools/knownTools.spec.ts` — render the low-level `Workflow` call as compact activity and never dump its JavaScript input.
- Modify `packages/happy-app/sources/text/_default.ts` and every file under `packages/happy-app/sources/text/translations/*.ts` — add the strict workflow-monitor strings.

## Protocol invariants used throughout the plan

- A task enters the monitor only when its event or background-task entry has `task_type === 'local_workflow'`.
- Workflow identity is Claude's `task_id`; `Task`, `Agent`, shell processes, and generic background tasks never enter the set.
- `task_progress` without a non-empty valid `workflow_progress` array preserves the previous hierarchy.
- `task_notification`, a terminal `task_updated`, or disappearance from `background_tasks_changed` removes the workflow synchronously from the next published snapshot.
- A pending progress timer is cancelled before any immediate publication, preventing an older snapshot from resurrecting a removed workflow.
- `activeWorkflows` stores only live workflows; no terminal history is synchronized or rendered.
- The desktop workflow panel is React state, not a persisted `SidebarMode`, so closing it reveals the untouched Files panel configuration.

### Task 1: Define snapshots and implement the pure Claude workflow reducer

**Files:**
- Modify: `packages/happy-cli/src/api/types.ts:388`
- Create: `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.ts`
- Create: `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.test.ts`

- [ ] **Step 1: Write failing reducer tests from the verified Claude Code lifecycle**

Create the test file with a small system-event factory and explicit cases. Use this fixture shape; it is intentionally limited to fields observed from Claude Code 2.1.220:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
    ClaudeWorkflowTracker,
    reduceClaudeWorkflowMessage,
    type ClaudeWorkflowReducerState,
} from './claudeWorkflowTracker';

const system = (subtype: string, fields: Record<string, unknown>) => ({
    type: 'system',
    subtype,
    uuid: `fixture-${subtype}`,
    ...fields,
});

const started = (taskId = 'workflow-1') => system('task_started', {
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    task_type: 'local_workflow',
    workflow_name: 'inspect-packages',
    description: 'Read both package manifests',
});

const fullProgress = system('task_progress', {
    task_id: 'workflow-1',
    summary: 'Reading package manifests',
    usage: { total_tokens: 24600, tool_uses: 2, duration_ms: 18000 },
    workflow_progress: [
        { type: 'workflow_phase', index: 2, title: 'Read CLI' },
        { type: 'workflow_phase', index: 1, title: 'Read app' },
        {
            type: 'workflow_agent', index: 2, label: 'happy-cli', phaseIndex: 2,
            phaseTitle: 'Read CLI', agentId: 'agent-cli', model: 'claude-sonnet-5',
            state: 'start', lastToolName: 'Read', lastToolSummary: 'packages/happy-cli/package.json',
        },
        {
            type: 'workflow_agent', index: 1, label: 'happy-app', phaseIndex: 1,
            phaseTitle: 'Read app', agentId: 'agent-app', model: 'claude-sonnet-5',
            state: 'done', lastToolName: 'Read', lastToolSummary: 'packages/happy-app/package.json',
        },
    ],
});

describe('reduceClaudeWorkflowMessage', () => {
    it('creates only local_workflow entries from background reconciliation', () => {
        const result = reduceClaudeWorkflowMessage({}, system('background_tasks_changed', {
            tasks: [
                { task_id: 'workflow-1', task_type: 'local_workflow', description: 'Native workflow' },
                { task_id: 'task-1', task_type: 'agent', description: 'Ordinary Task tool' },
                { task_id: 'shell-1', task_type: 'shell', description: 'Background shell' },
            ],
        }), 1000);

        expect(Object.keys(result.state)).toEqual(['workflow-1']);
        expect(result.state['workflow-1']).toMatchObject({
            taskId: 'workflow-1', name: 'Native workflow', startedAt: 1000, phases: [],
        });
        expect(result.publication).toBe('immediate');
    });

    it('enriches a fallback entry without duplicating it', () => {
        const fallback = reduceClaudeWorkflowMessage({}, system('background_tasks_changed', {
            tasks: [{ task_id: 'workflow-1', task_type: 'local_workflow', description: 'Fallback' }],
        }), 1000).state;
        const result = reduceClaudeWorkflowMessage(fallback, started(), 1100);

        expect(Object.keys(result.state)).toEqual(['workflow-1']);
        expect(result.state['workflow-1']).toMatchObject({
            toolUseId: 'tool-workflow-1', name: 'inspect-packages',
            description: 'Read both package manifests', startedAt: 1000, updatedAt: 1100,
        });
    });

    it('groups and sorts phases and agents by Claude indices', () => {
        const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const result = reduceClaudeWorkflowMessage(state, fullProgress, 2000);

        expect(result.publication).toBe('progress');
        expect(result.state['workflow-1'].usage).toEqual({
            totalTokens: 24600, toolUses: 2, durationMs: 18000,
        });
        expect(result.state['workflow-1'].phases.map((phase) => phase.index)).toEqual([1, 2]);
        expect(result.state['workflow-1'].phases[0].agents[0]).toMatchObject({
            id: 'agent-app', index: 1, state: 'done', lastToolName: 'Read',
        });
    });

    it('retains orphaned agents in a final Other phase', () => {
        const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const result = reduceClaudeWorkflowMessage(state, system('task_progress', {
            task_id: 'workflow-1',
            workflow_progress: [{
                type: 'workflow_agent', index: 7, label: 'orphan', phaseIndex: 99,
                agentId: 'agent-orphan', state: 'start',
            }],
        }), 2000);

        expect(result.state['workflow-1'].phases).toEqual([
            expect.objectContaining({ index: -1, title: 'Other', agents: [expect.objectContaining({ id: 'agent-orphan' })] }),
        ]);
    });

    it('keeps the last hierarchy when progress omits workflow_progress', () => {
        const startedState = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const withHierarchy = reduceClaudeWorkflowMessage(startedState, fullProgress, 2000).state;
        const heartbeat = reduceClaudeWorkflowMessage(withHierarchy, system('task_progress', {
            task_id: 'workflow-1', usage: { total_tokens: 25000 },
        }), 3000).state;

        expect(heartbeat['workflow-1'].phases).toEqual(withHierarchy['workflow-1'].phases);
        expect(heartbeat['workflow-1'].usage?.totalTokens).toBe(25000);
        expect(heartbeat['workflow-1'].usage?.toolUses).toBe(2);
    });

    it('skips malformed progress entries while retaining valid entries', () => {
        const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const result = reduceClaudeWorkflowMessage(state, system('task_progress', {
            task_id: 'workflow-1',
            workflow_progress: [
                { type: 'workflow_phase', index: 1, title: 'Valid phase' },
                { type: 'workflow_phase', index: 'bad', title: 42 },
                { type: 'workflow_agent', index: 1, label: 'valid', phaseIndex: 1, agentId: 'valid-agent', state: 'start' },
                { type: 'workflow_agent', index: 2, label: 'missing id', phaseIndex: 1, state: 'start' },
            ],
        }), 2000);

        expect(result.state['workflow-1'].phases).toEqual([
            expect.objectContaining({ title: 'Valid phase', agents: [expect.objectContaining({ id: 'valid-agent' })] }),
        ]);
    });

    it('updates an agent from start to done in place', () => {
        const startedState = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const running = reduceClaudeWorkflowMessage(startedState, fullProgress, 2000).state;
        const doneEntries = (fullProgress.workflow_progress as Record<string, unknown>[]).map((entry) =>
            entry.agentId === 'agent-cli' ? { ...entry, state: 'done', durationMs: 22000 } : entry,
        );
        const done = reduceClaudeWorkflowMessage(running, system('task_progress', {
            task_id: 'workflow-1', workflow_progress: doneEntries,
        }), 3000).state;

        expect(done['workflow-1'].phases[1].agents).toHaveLength(1);
        expect(done['workflow-1'].phases[1].agents[0]).toMatchObject({ state: 'done', durationMs: 22000 });
    });

    it('isolates concurrent workflows and removes only terminal ids', () => {
        let state: ClaudeWorkflowReducerState = {};
        state = reduceClaudeWorkflowMessage(state, started('workflow-1'), 1000).state;
        state = reduceClaudeWorkflowMessage(state, started('workflow-2'), 1100).state;
        state = reduceClaudeWorkflowMessage(state, system('task_notification', {
            task_id: 'workflow-1', status: 'completed',
        }), 2000).state;
        expect(Object.keys(state)).toEqual(['workflow-2']);
        state = reduceClaudeWorkflowMessage(state, system('task_updated', {
            task_id: 'workflow-2', status: 'failed',
        }), 2100).state;
        expect(state).toEqual({});
    });

    it('removes workflows absent from a complete background task snapshot', () => {
        const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        const result = reduceClaudeWorkflowMessage(state, system('background_tasks_changed', {
            tasks: [{ task_id: 'some-shell', task_type: 'shell' }],
        }), 2000);
        expect(result.state).toEqual({});
        expect(result.publication).toBe('immediate');
    });

    it('ignores malformed and non-system events without clearing active state', () => {
        const state = reduceClaudeWorkflowMessage({}, started(), 1000).state;
        expect(reduceClaudeWorkflowMessage(state, { type: 'assistant' }, 2000).state).toBe(state);
        expect(reduceClaudeWorkflowMessage(state, system('task_progress', { task_id: 4 }), 2000).state).toBe(state);
    });
});
```

- [ ] **Step 2: Run the reducer test and verify the expected failure**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/claude/workflows/claudeWorkflowTracker.test.ts
```

Expected: FAIL because `./claudeWorkflowTracker` does not exist.

- [ ] **Step 3: Add the encrypted snapshot types**

Insert these exports immediately before `AgentState` in `packages/happy-cli/src/api/types.ts`, then add `activeWorkflows?: Record<string, ActiveWorkflowSnapshot>` to `AgentState`:

```ts
export type ActiveWorkflowAgentSnapshot = {
  id: string
  index: number
  label: string
  model?: string
  state: string
  queuedAt?: number
  startedAt?: number
  lastToolName?: string
  lastToolSummary?: string
  lastProgressAt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
}

export type ActiveWorkflowPhaseSnapshot = {
  index: number
  title: string
  agents: ActiveWorkflowAgentSnapshot[]
}

export type ActiveWorkflowSnapshot = {
  taskId: string
  toolUseId?: string
  name: string
  description?: string
  startedAt: number
  updatedAt: number
  usage?: {
    totalTokens?: number
    toolUses?: number
    durationMs?: number
  }
  phases: ActiveWorkflowPhaseSnapshot[]
}

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  usageLimits?: UsageLimits
  activeWorkflows?: Record<string, ActiveWorkflowSnapshot>
  requests?: {
```

Keep all existing `requests`, `completedRequests`, and `agentGoalStatus` members unchanged after the shown insertion.

- [ ] **Step 4: Implement the pure reducer with strict native-workflow filtering**

Create `claudeWorkflowTracker.ts` with these public contracts and helpers:

```ts
import type {
    ActiveWorkflowAgentSnapshot,
    ActiveWorkflowPhaseSnapshot,
    ActiveWorkflowSnapshot,
} from '@/api/types';

export type ClaudeWorkflowReducerState = Record<string, ActiveWorkflowSnapshot>;
export type ClaudeWorkflowPublication = 'none' | 'progress' | 'immediate';

export type ClaudeWorkflowReducerResult = {
    state: ClaudeWorkflowReducerState;
    publication: ClaudeWorkflowPublication;
};

type UnknownRecord = Record<string, unknown>;

const TERMINAL_STATUSES = new Set(['completed', 'done', 'success', 'failed', 'error', 'cancelled', 'canceled']);

function record(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function defined<T extends UnknownRecord>(value: T): T | undefined {
    return Object.values(value).some((entry) => entry !== undefined) ? value : undefined;
}

function taskId(message: UnknownRecord): string | undefined {
    return text(message.task_id) ?? text(record(message.task)?.task_id) ?? text(record(message.task)?.id);
}

function taskStatus(message: UnknownRecord): string | undefined {
    return text(message.status) ?? text(record(message.task)?.status) ?? text(record(message.update)?.status);
}

function parseUsage(message: UnknownRecord, previous: ActiveWorkflowSnapshot['usage']): ActiveWorkflowSnapshot['usage'] {
    const usage = record(message.usage) ?? message;
    return defined({
        totalTokens: finite(usage.total_tokens) ?? finite(usage.totalTokens) ?? previous?.totalTokens,
        toolUses: finite(usage.tool_uses) ?? finite(usage.tool_calls) ?? finite(usage.toolUses) ?? previous?.toolUses,
        durationMs: finite(usage.duration_ms) ?? finite(usage.durationMs) ?? previous?.durationMs,
    });
}

function parseAgent(entry: UnknownRecord): (ActiveWorkflowAgentSnapshot & { phaseIndex: number }) | null {
    if (entry.type !== 'workflow_agent') return null;
    const id = text(entry.agentId);
    const index = finite(entry.index);
    const label = text(entry.label);
    const phaseIndex = finite(entry.phaseIndex);
    const state = text(entry.state);
    if (!id || index === undefined || !label || phaseIndex === undefined || !state) return null;
    return {
        id, index, label, phaseIndex, state,
        model: text(entry.model),
        queuedAt: finite(entry.queuedAt),
        startedAt: finite(entry.startedAt),
        lastToolName: text(entry.lastToolName),
        lastToolSummary: text(entry.lastToolSummary),
        lastProgressAt: finite(entry.lastProgressAt),
        tokens: finite(entry.tokens),
        toolCalls: finite(entry.toolCalls),
        durationMs: finite(entry.durationMs),
    };
}

function parseHierarchy(value: unknown): ActiveWorkflowPhaseSnapshot[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const phases = new Map<number, ActiveWorkflowPhaseSnapshot>();
    const agentEntries: Array<{ agent: ActiveWorkflowAgentSnapshot; phaseIndex: number; phaseTitle?: string }> = [];

    for (const rawEntry of value) {
        const entry = record(rawEntry);
        if (!entry) continue;
        if (entry.type === 'workflow_phase') {
            const index = finite(entry.index);
            const title = text(entry.title);
            if (index !== undefined && title) phases.set(index, { index, title, agents: [] });
            continue;
        }
        const parsed = parseAgent(entry);
        if (!parsed) continue;
        const { phaseIndex, ...agent } = parsed;
        agentEntries.push({ agent, phaseIndex, phaseTitle: text(entry.phaseTitle) });
    }

    if (phases.size === 0 && agentEntries.length === 0) return undefined;
    let other: ActiveWorkflowPhaseSnapshot | undefined;
    for (const entry of agentEntries) {
        let phase = phases.get(entry.phaseIndex);
        if (!phase && entry.phaseTitle) {
            phase = { index: entry.phaseIndex, title: entry.phaseTitle, agents: [] };
            phases.set(entry.phaseIndex, phase);
        }
        if (!phase) {
            other ??= { index: -1, title: 'Other', agents: [] };
            phase = other;
        }
        phase.agents.push(entry.agent);
    }

    const ordered = [...phases.values()].sort((a, b) => a.index - b.index);
    if (other) ordered.push(other);
    for (const phase of ordered) phase.agents.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    return ordered;
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function backgroundTasks(message: UnknownRecord): unknown[] | null {
    if (Array.isArray(message.tasks)) return message.tasks;
    if (Array.isArray(message.background_tasks)) return message.background_tasks;
    return null;
}

export function reduceClaudeWorkflowMessage(
    state: ClaudeWorkflowReducerState,
    rawMessage: unknown,
    now: number = Date.now(),
): ClaudeWorkflowReducerResult {
    const message = record(rawMessage);
    if (!message || message.type !== 'system') return { state, publication: 'none' };
    const subtype = text(message.subtype);

    if (subtype === 'background_tasks_changed') {
        const tasks = backgroundTasks(message);
        if (!tasks) return { state, publication: 'none' };
        const next: ClaudeWorkflowReducerState = {};
        for (const rawTask of tasks) {
            const task = record(rawTask);
            if (!task || task.task_type !== 'local_workflow') continue;
            const id = text(task.task_id) ?? text(task.id);
            if (!id) continue;
            const previous = state[id];
            const description = text(task.description) ?? previous?.description;
            next[id] = previous ?? {
                taskId: id,
                name: text(task.workflow_name) ?? description ?? 'Workflow',
                description,
                startedAt: now,
                updatedAt: now,
                phases: [],
            };
        }
        return same(state, next)
            ? { state, publication: 'none' }
            : { state: next, publication: 'immediate' };
    }

    const id = taskId(message);
    if (!id) return { state, publication: 'none' };

    if (subtype === 'task_started') {
        if (message.task_type !== 'local_workflow') return { state, publication: 'none' };
        const previous = state[id];
        const description = text(message.description) ?? previous?.description;
        const workflow: ActiveWorkflowSnapshot = {
            taskId: id,
            toolUseId: text(message.tool_use_id) ?? previous?.toolUseId,
            name: text(message.workflow_name) ?? previous?.name ?? description ?? 'Workflow',
            description,
            startedAt: previous?.startedAt ?? now,
            updatedAt: now,
            usage: previous?.usage,
            phases: previous?.phases ?? [],
        };
        return { state: { ...state, [id]: workflow }, publication: 'immediate' };
    }

    if ((subtype === 'task_notification' && state[id]) ||
        (subtype === 'task_updated' && state[id] && TERMINAL_STATUSES.has(taskStatus(message) ?? ''))) {
        const next = { ...state };
        delete next[id];
        return { state: next, publication: 'immediate' };
    }

    if (subtype !== 'task_progress' || !state[id]) return { state, publication: 'none' };
    const previous = state[id];
    const progressContainer = record(message.progress);
    const hierarchy = parseHierarchy(message.workflow_progress ?? progressContainer?.workflow_progress);
    const description = text(message.summary) ?? text(message.description) ?? previous.description;
    const workflow: ActiveWorkflowSnapshot = {
        ...previous,
        description,
        updatedAt: now,
        usage: parseUsage(message, previous.usage),
        phases: hierarchy ?? previous.phases,
    };
    return same(previous, workflow)
        ? { state, publication: 'none' }
        : { state: { ...state, [id]: workflow }, publication: 'progress' };
}
```

The reducer deliberately recognizes both `tasks` and `background_tasks`, and both direct and nested status/usage fields, so additive SDK envelope changes do not break detection. It still requires the exact `local_workflow` discriminator before creation.

- [ ] **Step 5: Run the reducer tests and verify they pass**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/claude/workflows/claudeWorkflowTracker.test.ts
```

Expected: PASS for all reducer cases. Publisher tests are added in Task 2.

- [ ] **Step 6: Commit the reducer and snapshot contract**

```powershell
git add packages/happy-cli/src/api/types.ts packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.ts packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.test.ts
git commit -m "feat(cli): reduce Claude native workflow events"
```

### Task 2: Publish workflow snapshots through encrypted agent state

**Files:**
- Modify: `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.ts`
- Modify: `packages/happy-cli/src/claude/workflows/claudeWorkflowTracker.test.ts`
- Modify: `packages/happy-cli/src/api/apiSession.ts:193-239,707-728,948-970,1000-1020`
- Modify: `packages/happy-cli/src/api/apiSession.test.ts`
- Modify: `packages/happy-cli/src/claude/claudeLocalLauncher.ts`
- Modify: `packages/happy-cli/src/claude/claudeLocalLauncher.test.ts`
- Modify: `packages/happy-cli/src/claude/claudeRemoteLauncher.ts`

- [ ] **Step 1: Add failing fake-timer tests for coalescing, removal, and reset**

Append this suite to `claudeWorkflowTracker.test.ts`:

```ts
describe('ClaudeWorkflowTracker publisher', () => {
    it('publishes starts immediately and coalesces progress for 250 ms', async () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const tracker = new ClaudeWorkflowTracker(publish, { now: () => 1000 });

        tracker.handle(started());
        expect(publish).toHaveBeenCalledTimes(1);
        tracker.handle(fullProgress);
        tracker.handle(system('task_progress', {
            task_id: 'workflow-1', usage: { total_tokens: 25000 },
        }));
        expect(publish).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(249);
        expect(publish).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0]['workflow-1'].usage.totalTokens).toBe(25000);
        tracker.dispose();
    });

    it('cancels pending progress before terminal removal', async () => {
        vi.useFakeTimers();
        const publish = vi.fn();
        const tracker = new ClaudeWorkflowTracker(publish, { now: () => 1000 });
        tracker.handle(started());
        tracker.handle(fullProgress);
        tracker.handle(system('task_notification', { task_id: 'workflow-1', status: 'completed' }));

        expect(publish).toHaveBeenLastCalledWith({});
        await vi.advanceTimersByTimeAsync(300);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenLastCalledWith({});
        tracker.dispose();
    });

    it('force-publishes an empty reset even when in-memory state is empty', () => {
        const publish = vi.fn();
        const tracker = new ClaudeWorkflowTracker(publish);
        tracker.reset();
        expect(publish).toHaveBeenCalledWith({});
        tracker.handle(started());
        expect(tracker.snapshot()).toHaveProperty('workflow-1');
        tracker.reset();
        expect(tracker.snapshot()).toEqual({});
        expect(publish).toHaveBeenLastCalledWith({});
        tracker.dispose();
    });
});
```

- [ ] **Step 2: Run the tracker test and verify the expected failure**

Run the Task 1 Vitest command again.

Expected: FAIL because `ClaudeWorkflowTracker` is not exported yet.

- [ ] **Step 3: Add the coalescing publisher to the tracker file**

Append this class after the pure reducer:

```ts
export class ClaudeWorkflowTracker {
    private state: ClaudeWorkflowReducerState = {};
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly now: () => number;
    private readonly coalesceMs: number;

    constructor(
        private readonly publish: (snapshot: ClaudeWorkflowReducerState) => void,
        options: { now?: () => number; coalesceMs?: number } = {},
    ) {
        this.now = options.now ?? Date.now;
        this.coalesceMs = options.coalesceMs ?? 250;
    }

    handle(message: unknown): void {
        const result = reduceClaudeWorkflowMessage(this.state, message, this.now());
        if (result.publication === 'none') return;
        this.state = result.state;
        if (result.publication === 'immediate') {
            this.cancelPending();
            this.publishCurrent();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.publishCurrent();
            }, this.coalesceMs);
        }
    }

    reset(): void {
        this.cancelPending();
        this.state = {};
        this.publishCurrent();
    }

    dispose(): void {
        this.cancelPending();
    }

    snapshot(): ClaudeWorkflowReducerState {
        return this.state;
    }

    private publishCurrent(): void {
        this.publish({ ...this.state });
    }

    private cancelPending(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}
```

- [ ] **Step 4: Add a failing `ApiSessionClient` integration test**

In `apiSession.test.ts`, add one test using the existing socket mock. Make `emitWithAck` echo encrypted agent state for `update-state`, send a start followed by a terminal event, and assert both encrypted snapshots:

```ts
it('tracks Claude workflow system events before the chat mapper drops them', async () => {
    let version = 0;
    mockSocket.emitWithAck.mockImplementation(async (event: string, payload: any) => {
        if (event !== 'update-state') return { result: 'error' };
        version += 1;
        return { result: 'success', version, agentState: payload.agentState };
    });
    const client = new ApiSessionClient('fake-token', session);

    client.sendClaudeSessionMessage({
        type: 'system', uuid: 'workflow-start', subtype: 'task_started',
        task_id: 'workflow-1', task_type: 'local_workflow', workflow_name: 'inspect-packages',
    } as any);

    await waitForCheck(() => {
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('update-state', expect.any(Object));
    });
    const firstPayload = mockSocket.emitWithAck.mock.calls.find(([event]) => event === 'update-state')![1];
    expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(firstPayload.agentState))).toMatchObject({
        activeWorkflows: { 'workflow-1': { taskId: 'workflow-1', name: 'inspect-packages' } },
    });

    client.sendClaudeSessionMessage({
        type: 'system', uuid: 'workflow-done', subtype: 'task_notification',
        task_id: 'workflow-1', status: 'completed',
    } as any);
    await waitForCheck(() => {
        expect(mockSocket.emitWithAck.mock.calls.filter(([event]) => event === 'update-state')).toHaveLength(2);
    });
    const secondPayload = mockSocket.emitWithAck.mock.calls.filter(([event]) => event === 'update-state')[1][1];
    expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(secondPayload.agentState))).not.toHaveProperty('activeWorkflows');
    expect(mockAxiosPost).not.toHaveBeenCalled();
    await client.close();
});
```

Expected failure before integration: no `update-state` call is made because all Claude `system` messages are currently discarded by the conversation mapper.

- [ ] **Step 5: Wire the tracker into `ApiSessionClient` without extending the session-message protocol**

Import `ClaudeWorkflowTracker`, add a private tracker field, and construct it after the socket has been created:

```ts
private readonly claudeWorkflowTracker: ClaudeWorkflowTracker;

// In the constructor, after this.socket is assigned:
this.claudeWorkflowTracker = new ClaudeWorkflowTracker((activeWorkflows) => {
    this.updateAgentState((current) => {
        const next = { ...current };
        if (Object.keys(activeWorkflows).length === 0) {
            delete next.activeWorkflows;
        } else {
            next.activeWorkflows = activeWorkflows;
        }
        return next;
    });
});
```

At the first line of `sendClaudeSessionMessage`, observe the raw message before mapping:

```ts
sendClaudeSessionMessage(body: RawJSONLines) {
    this.claudeWorkflowTracker.handle(body);
    const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
```

Expose runtime-boundary methods and dispose only the local timer during API cleanup:

```ts
resetClaudeWorkflows(): void {
    this.claudeWorkflowTracker.reset();
}

async close() {
    logger.debug('[API] socket.close() called');
    this.claudeWorkflowTracker.dispose();
    this.sendSync.stop();
```

Do not call `reset()` from a network disconnect handler: the Claude process and its workflow may still be running while the app reconnects.

- [ ] **Step 6: Add failing local-runtime reset assertions, then wire both launchers**

Add `resetClaudeWorkflows: vi.fn()` to every `session.client` fixture in `claudeLocalLauncher.test.ts`. In the first launcher test assert it was called at least once before `mockClaudeLocal` starts and once again during final cleanup:

```ts
expect(session.client.resetClaudeWorkflows).toHaveBeenCalled();
const callsBeforeRuntime = session.client.resetClaudeWorkflows.mock.invocationCallOrder[0];
const runtimeStart = mockClaudeLocal.mock.invocationCallOrder[0];
expect(callsBeforeRuntime).toBeLessThan(runtimeStart);
await expect(launcher).resolves.toEqual({ type: 'switch' });
expect(session.client.resetClaudeWorkflows.mock.calls.length).toBeGreaterThanOrEqual(2);
```

In `claudeLocalLauncher.ts`, reset immediately before every process launch and again in the outer cleanup:

```ts
logger.debug('[local]: launch');
session.client.resetClaudeWorkflows();
try {
    await claudeLocal({
```

```ts
} finally {
    session.client.resetClaudeWorkflows();
    exutFuture.resolve(undefined);
```

In `claudeRemoteLauncher.ts`, place the same calls around each `claudeRemote(...)` runtime:

```ts
try {
    session.client.resetClaudeWorkflows();
    const remoteResult = await claudeRemote({
```

```ts
} finally {
    session.client.resetClaudeWorkflows();
    logger.debug('[remote]: launch finally');
```

This treats process restarts, mode switches, aborts, and crashes as workflow-lifetime boundaries.

- [ ] **Step 7: Run focused CLI tests and typecheck**

```powershell
pnpm --filter happy exec vitest run --project unit src/claude/workflows/claudeWorkflowTracker.test.ts src/api/apiSession.test.ts src/claude/claudeLocalLauncher.test.ts
pnpm --filter happy typecheck
```

Expected: all focused tests PASS and TypeScript exits with code 0.

- [ ] **Step 8: Commit encrypted publication and runtime cleanup**

```powershell
git add packages/happy-cli/src/claude/workflows packages/happy-cli/src/api/apiSession.ts packages/happy-cli/src/api/apiSession.test.ts packages/happy-cli/src/claude/claudeLocalLauncher.ts packages/happy-cli/src/claude/claudeLocalLauncher.test.ts packages/happy-cli/src/claude/claudeRemoteLauncher.ts
git commit -m "feat(cli): sync active Claude workflows"
```

### Task 3: Parse workflow state defensively and build the pure app model

**Files:**
- Modify: `packages/happy-app/sources/sync/storageTypes.ts:210-258`
- Modify: `packages/happy-app/sources/sync/storageTypes.spec.ts`
- Create: `packages/happy-app/sources/components/workflows/workflowModel.ts`
- Create: `packages/happy-app/sources/components/workflows/workflowModel.test.ts`

- [ ] **Step 1: Add failing agent-state schema tests**

Append these tests to `storageTypes.spec.ts`:

```ts
it('parses valid active workflows and drops malformed siblings', () => {
    const state = AgentStateSchema.parse({
        controlledByUser: true,
        requests: {
            permission: { tool: 'Read', arguments: {}, createdAt: 10 },
        },
        activeWorkflows: {
            good: {
                taskId: 'good', name: 'inspect-packages', startedAt: 1000, updatedAt: 1200,
                phases: [{
                    index: 1, title: 'Read', agents: [{
                        id: 'agent-1', index: 1, label: 'reader', state: 'start',
                        lastToolName: 'Read', lastToolSummary: 'package.json',
                    }],
                }],
            },
            bad: { taskId: 7, name: null, phases: 'broken' },
        },
    });

    expect(state.controlledByUser).toBe(true);
    expect(state.requests?.permission.tool).toBe('Read');
    expect(Object.keys(state.activeWorkflows ?? {})).toEqual(['good']);
});

it('does not invalidate permission state when activeWorkflows itself is malformed', () => {
    const state = AgentStateSchema.parse({
        requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 10 } },
        activeWorkflows: 'not-a-record',
    });
    expect(state.requests?.permission.tool).toBe('Bash');
    expect(state.activeWorkflows).toBeUndefined();
});
```

- [ ] **Step 2: Add failing pure-model tests for ordering, state mapping, formatting, and panel behavior**

Create `workflowModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ActiveWorkflowSnapshot } from '@/sync/storageTypes';
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
    return { taskId, name: taskId, startedAt, updatedAt: startedAt, phases: [] };
}

describe('workflowModel', () => {
    it('sorts oldest first and task id as a stable tie-breaker', () => {
        expect(selectActiveWorkflows({
            c: workflow('c', 200), b: workflow('b', 100), a: workflow('a', 100),
        }).map((item) => item.taskId)).toEqual(['a', 'b', 'c']);
    });

    it.each([
        ['start', 'running'], ['running', 'running'], ['in_progress', 'running'],
        ['done', 'completed'], ['completed', 'completed'], ['success', 'completed'],
        ['error', 'error'], ['failed', 'error'], ['future-state', 'active'],
    ] as const)('maps provider state %s to %s', (provider, visual) => {
        expect(normalizeWorkflowAgentState(provider)).toBe(visual);
    });

    it('derives phase state without relying on color', () => {
        expect(getPhaseVisualState({ index: 1, title: 'empty', agents: [] })).toBe('active');
        expect(getPhaseVisualState({ index: 1, title: 'run', agents: [
            { id: 'a', index: 1, label: 'a', state: 'start' },
        ] })).toBe('running');
        expect(getPhaseVisualState({ index: 1, title: 'done', agents: [
            { id: 'a', index: 1, label: 'a', state: 'done' },
        ] })).toBe('completed');
        expect(getPhaseVisualState({ index: 1, title: 'error', agents: [
            { id: 'a', index: 1, label: 'a', state: 'failed' },
        ] })).toBe('error');
    });

    it('hides the badge at zero and distinguishes singular/plural counts', () => {
        expect(getWorkflowBadgeModel(0)).toBeNull();
        expect(getWorkflowBadgeModel(1)).toEqual({ count: 1, plural: false });
        expect(getWorkflowBadgeModel(3)).toEqual({ count: 3, plural: true });
    });

    it('uses a context panel only on a capable wide desktop surface', () => {
        expect(canUseWorkflowContextPanel({ platform: 'web', isMacDesktop: false, width: 1200, ready: true, hasSession: true })).toBe(true);
        expect(canUseWorkflowContextPanel({ platform: 'web', isMacDesktop: false, width: 900, ready: true, hasSession: true })).toBe(false);
        expect(canUseWorkflowContextPanel({ platform: 'ios', isMacDesktop: false, width: 1200, ready: true, hasSession: true })).toBe(false);
        expect(resolveWorkflowOpenTarget(true)).toBe('context-panel');
        expect(resolveWorkflowOpenTarget(false)).toBe('route');
    });

    it('never auto-opens, closes manually, and auto-closes on the final removal', () => {
        expect(reduceWorkflowPanelOpen(false, { type: 'active-count', count: 2 })).toBe(false);
        expect(reduceWorkflowPanelOpen(false, { type: 'open' })).toBe(true);
        expect(reduceWorkflowPanelOpen(true, { type: 'close' })).toBe(false);
        expect(reduceWorkflowPanelOpen(true, { type: 'active-count', count: 0 })).toBe(false);
        expect(shouldDismissWorkflowRoute(0)).toBe(true);
        expect(shouldDismissWorkflowRoute(1)).toBe(false);
    });

    it('formats elapsed time and compact token usage deterministically', () => {
        expect(formatWorkflowElapsed(1000, 19000)).toBe('00:18');
        expect(formatWorkflowElapsed(1000, 3_662_000)).toBe('1:01:01');
        expect(formatWorkflowTokens(999)).toBe('999');
        expect(formatWorkflowTokens(24_600)).toBe('24.6k');
    });
});
```

- [ ] **Step 3: Run both files and verify the expected failures**

```powershell
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts sources/components/workflows/workflowModel.test.ts
```

Expected: FAIL because `activeWorkflows` is stripped by `AgentStateSchema` and `workflowModel.ts` does not exist.

- [ ] **Step 4: Add passthrough workflow schemas with per-entry recovery**

Insert these schemas before `AgentStateSchema` in `storageTypes.ts`:

```ts
export const ActiveWorkflowAgentSnapshotSchema = z.object({
    id: z.string().trim().min(1),
    index: z.number().int(),
    label: z.string().trim().min(1),
    model: z.string().optional(),
    state: z.string().trim().min(1),
    queuedAt: z.number().optional(),
    startedAt: z.number().optional(),
    lastToolName: z.string().optional(),
    lastToolSummary: z.string().optional(),
    lastProgressAt: z.number().optional(),
    tokens: z.number().optional(),
    toolCalls: z.number().optional(),
    durationMs: z.number().optional(),
}).passthrough();

export const ActiveWorkflowPhaseSnapshotSchema = z.object({
    index: z.number().int(),
    title: z.string().trim().min(1),
    agents: z.array(ActiveWorkflowAgentSnapshotSchema),
}).passthrough();

export const ActiveWorkflowSnapshotSchema = z.object({
    taskId: z.string().trim().min(1),
    toolUseId: z.string().optional(),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    startedAt: z.number(),
    updatedAt: z.number(),
    usage: z.object({
        totalTokens: z.number().optional(),
        toolUses: z.number().optional(),
        durationMs: z.number().optional(),
    }).passthrough().optional(),
    phases: z.array(ActiveWorkflowPhaseSnapshotSchema),
}).passthrough();

export type ActiveWorkflowAgentSnapshot = z.infer<typeof ActiveWorkflowAgentSnapshotSchema>;
export type ActiveWorkflowPhaseSnapshot = z.infer<typeof ActiveWorkflowPhaseSnapshotSchema>;
export type ActiveWorkflowSnapshot = z.infer<typeof ActiveWorkflowSnapshotSchema>;

const ActiveWorkflowsSchema = z.record(z.string(), z.unknown()).transform((input) => {
    const valid: Record<string, ActiveWorkflowSnapshot> = {};
    for (const [key, value] of Object.entries(input)) {
        const parsed = ActiveWorkflowSnapshotSchema.safeParse(value);
        if (parsed.success) valid[key] = parsed.data;
    }
    return valid;
}).optional().catch(undefined);
```

Add this member to `AgentStateSchema` beside `usageLimits`:

```ts
activeWorkflows: ActiveWorkflowsSchema,
```

The record-level `.catch(undefined)` protects permissions when the field is not a record; the transform's per-entry `safeParse` preserves valid workflows when only one sibling is malformed.

- [ ] **Step 5: Implement the pure workflow display model**

Create `workflowModel.ts`:

```ts
import type {
    ActiveWorkflowPhaseSnapshot,
    ActiveWorkflowSnapshot,
} from '@/sync/storageTypes';

export type WorkflowVisualState = 'running' | 'completed' | 'error' | 'active';
export type WorkflowOpenTarget = 'context-panel' | 'route';
export type WorkflowPanelEvent =
    | { type: 'open' }
    | { type: 'close' }
    | { type: 'active-count'; count: number };

export function selectActiveWorkflows(
    workflows: Record<string, ActiveWorkflowSnapshot> | null | undefined,
): ActiveWorkflowSnapshot[] {
    return Object.values(workflows ?? {}).sort(
        (left, right) => left.startedAt - right.startedAt || left.taskId.localeCompare(right.taskId),
    );
}

export function normalizeWorkflowAgentState(state: string): WorkflowVisualState {
    const normalized = state.toLowerCase();
    if (['start', 'running', 'in_progress'].includes(normalized)) return 'running';
    if (['done', 'completed', 'success'].includes(normalized)) return 'completed';
    if (['error', 'failed'].includes(normalized)) return 'error';
    return 'active';
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

export function canUseWorkflowContextPanel(input: {
    platform: string;
    isMacDesktop: boolean;
    width: number;
    ready: boolean;
    hasSession: boolean;
}): boolean {
    return input.ready
        && input.hasSession
        && input.width >= 1100
        && (input.platform === 'web' || input.isMacDesktop);
}

export function resolveWorkflowOpenTarget(canUseContextPanel: boolean): WorkflowOpenTarget {
    return canUseContextPanel ? 'context-panel' : 'route';
}

export function reduceWorkflowPanelOpen(open: boolean, event: WorkflowPanelEvent): boolean {
    if (event.type === 'open') return true;
    if (event.type === 'close') return false;
    return event.count === 0 ? false : open;
}

export function shouldDismissWorkflowRoute(count: number): boolean {
    return count === 0;
}

export function formatWorkflowElapsed(startedAt: number, now: number): string {
    const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatWorkflowTokens(tokens: number): string {
    if (tokens < 1000) return String(Math.round(tokens));
    const value = Math.round(tokens / 100) / 10;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
}
```

- [ ] **Step 6: Run the app model tests and typecheck**

```powershell
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts sources/components/workflows/workflowModel.test.ts
pnpm --filter happy-app typecheck
```

Expected: both files PASS and TypeScript exits with code 0.

- [ ] **Step 7: Commit the app state contract and model**

```powershell
git add packages/happy-app/sources/sync/storageTypes.ts packages/happy-app/sources/sync/storageTypes.spec.ts packages/happy-app/sources/components/workflows/workflowModel.ts packages/happy-app/sources/components/workflows/workflowModel.test.ts
git commit -m "feat(app): model active Claude workflows"
```

### Task 4: Build the approved badge and shared workflow panel

**Files:**
- Create: `packages/happy-app/sources/components/workflows/WorkflowActivityBadge.tsx`
- Create: `packages/happy-app/sources/components/workflows/WorkflowPanel.tsx`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/ca.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`
- Modify: `packages/happy-app/sources/text/translations/es.ts`
- Modify: `packages/happy-app/sources/text/translations/it.ts`
- Modify: `packages/happy-app/sources/text/translations/ja.ts`
- Modify: `packages/happy-app/sources/text/translations/pl.ts`
- Modify: `packages/happy-app/sources/text/translations/pt.ts`
- Modify: `packages/happy-app/sources/text/translations/ru.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hans.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hant.ts`

- [ ] **Step 1: Extend the pure-model test with the exact panel text-state contract**

Append this test to `workflowModel.test.ts`, then run the focused file. It should pass before any `.tsx` component is created, proving the panel needs no untested UI-only state inference:

```ts
it('keeps a mixed phase running and treats unknown provider states as active', () => {
    expect(getPhaseVisualState({ index: 2, title: 'mixed', agents: [
        { id: 'done', index: 1, label: 'done', state: 'completed' },
        { id: 'run', index: 2, label: 'run', state: 'in_progress' },
    ] })).toBe('running');
    expect(normalizeWorkflowAgentState('provider-added-state')).toBe('active');
});
```

- [ ] **Step 2: Add strict translations before components reference them**

Add this object beside the existing `tools`/`session` namespaces in `_default.ts`:

```ts
workflows: {
    activeTitle: 'Active workflows',
    workflowCount: ({ count }: { count: number }) => count === 1 ? '1 workflow' : `${count} workflows`,
    runningCount: ({ count }: { count: number }) => `${count} running`,
    badgeAccessibility: ({ count }: { count: number }) => count === 1
        ? '1 active workflow. Open workflow monitor'
        : `${count} active workflows. Open workflow monitor`,
    closeMonitor: 'Close workflow monitor',
    dismissAutomatically: 'Completed workflows disappear automatically.',
    otherPhase: 'Other',
    states: {
        running: 'Running',
        completed: 'Completed',
        error: 'Error',
        active: 'Active',
    },
    phaseAccessibility: ({ title, state }: { title: string; state: string }) => `${title}, ${state}`,
    agentAccessibility: ({ label, state }: { label: string; state: string }) => `${label}, ${state}`,
    tokens: ({ count }: { count: string }) => `${count} tokens`,
    toolCalls: ({ count }: { count: number }) => count === 1 ? '1 tool call' : `${count} tool calls`,
    toolTitle: 'Workflow',
},
```

Add the same keys and identical function parameter types to every strict translation file. To keep this implementation step deterministic, copy the exact English object above first, then replace only `activeTitle`, `otherPhase`, the four `states` values, and `toolTitle` with the constants in this table. Leave `workflowCount`, `runningCount`, `badgeAccessibility`, `closeMonitor`, `dismissAutomatically`, `phaseAccessibility`, `agentAccessibility`, `tokens`, and `toolCalls` exactly as shown in the English object until a dedicated localization pass supplies reviewed translations:

| Locale | Active title | Other | Running | Completed | Error | Active | Tool title |
|---|---|---|---|---|---|---|---|
| `ca` | Fluxos de treball actius | Altres | En execució | Completat | Error | Actiu | Flux de treball |
| `en` | Active workflows | Other | Running | Completed | Error | Active | Workflow |
| `es` | Flujos de trabajo activos | Otros | En ejecución | Completado | Error | Activo | Flujo de trabajo |
| `it` | Flussi di lavoro attivi | Altro | In esecuzione | Completato | Errore | Attivo | Flusso di lavoro |
| `ja` | 実行中のワークフロー | その他 | 実行中 | 完了 | エラー | アクティブ | ワークフロー |
| `pl` | Aktywne przepływy pracy | Inne | W toku | Ukończono | Błąd | Aktywny | Przepływ pracy |
| `pt` | Fluxos de trabalho ativos | Outros | Em execução | Concluído | Erro | Ativo | Fluxo de trabalho |
| `ru` | Активные рабочие процессы | Другое | Выполняется | Завершено | Ошибка | Активно | Рабочий процесс |
| `zh-Hans` | 活动工作流 | 其他 | 运行中 | 已完成 | 错误 | 活动 | 工作流 |
| `zh-Hant` | 活動工作流程 | 其他 | 執行中 | 已完成 | 錯誤 | 活動 | 工作流程 |

Run `pnpm --filter happy-app typecheck` after the translation edit. Expected: exit 0; any missing key fails the strict `TranslationStructure` assignment.

- [ ] **Step 3: Implement the conditional pulsing badge**

Create `WorkflowActivityBadge.tsx` with this behavior and structure:

```tsx
import * as React from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getWorkflowBadgeModel } from './workflowModel';

export const WorkflowActivityBadge = React.memo(function WorkflowActivityBadge(props: {
    count: number;
    onPress: () => void;
}) {
    const model = getWorkflowBadgeModel(props.count);
    const { theme } = useUnistyles();
    const pulse = React.useRef(new Animated.Value(0.45)).current;

    React.useEffect(() => {
        if (!model) return;
        const animation = Animated.loop(Animated.sequence([
            Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 0.45, duration: 650, useNativeDriver: true }),
        ]));
        animation.start();
        return () => animation.stop();
    }, [model?.count, pulse]);

    if (!model) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('workflows.badgeAccessibility', { count: model.count })}
            onPress={props.onPress}
            hitSlop={8}
            style={({ pressed }) => [
                styles.badge,
                { borderColor: theme.colors.warning, backgroundColor: `${theme.colors.warning}1F`, opacity: pressed ? 0.72 : 1 },
            ]}
        >
            <Animated.View style={[styles.pulse, { backgroundColor: theme.colors.warning, opacity: pulse }]} />
            <Text numberOfLines={1} style={[styles.label, { color: theme.colors.warning, ...Typography.default('semiBold') }]}>
                {t('workflows.workflowCount', { count: model.count })}
            </Text>
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    badge: {
        minHeight: 28,
        paddingHorizontal: 9,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 999,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    pulse: { width: 7, height: 7, borderRadius: 4 },
    label: { fontSize: 12, lineHeight: 16 },
}));
```

- [ ] **Step 4: Implement the shared workflow/phase/agent panel**

Create `WorkflowPanel.tsx`. The component must accept parsed snapshots, render no empty-history state, update elapsed labels once per second, and use the same body on desktop and the mobile route:

```tsx
import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { ActiveWorkflowSnapshot } from '@/sync/storageTypes';
import { t } from '@/text';
import {
    formatWorkflowElapsed,
    formatWorkflowTokens,
    getPhaseVisualState,
    normalizeWorkflowAgentState,
    type WorkflowVisualState,
} from './workflowModel';

function stateLabel(state: WorkflowVisualState): string {
    switch (state) {
        case 'running': return t('workflows.states.running');
        case 'completed': return t('workflows.states.completed');
        case 'error': return t('workflows.states.error');
        case 'active': return t('workflows.states.active');
    }
}

export const WorkflowPanel = React.memo(function WorkflowPanel(props: {
    workflows: ActiveWorkflowSnapshot[];
    onClose?: () => void;
    showHeader?: boolean;
}) {
    const { theme } = useUnistyles();
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    if (props.workflows.length === 0) return null;

    const colorFor = (state: WorkflowVisualState) => {
        if (state === 'running') return theme.colors.warning;
        if (state === 'completed') return theme.colors.success;
        if (state === 'error') return theme.colors.warningCritical;
        return theme.colors.textSecondary;
    };

    return (
        <View style={[styles.root, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            {props.showHeader !== false && (
                <View style={[styles.header, { borderColor: theme.colors.divider }]}>
                    <View>
                        <Text style={[styles.headerTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{t('workflows.activeTitle')}</Text>
                        <Text style={[styles.headerCount, { color: theme.colors.textSecondary, ...Typography.default() }]}>
                            {t('workflows.runningCount', { count: props.workflows.length })}
                        </Text>
                    </View>
                    {props.onClose && (
                        <Pressable accessibilityRole="button" accessibilityLabel={t('workflows.closeMonitor')} onPress={props.onClose} hitSlop={10}>
                            <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>
            )}
            <ScrollView contentContainerStyle={styles.content}>
                {props.workflows.map((workflow) => (
                    <View key={workflow.taskId} style={[styles.card, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                        <View style={[styles.workflowHeader, { borderColor: theme.colors.divider }]}>
                            <View style={styles.titleRow}>
                                <View style={[styles.dot, { backgroundColor: theme.colors.warning }]} />
                                <Text numberOfLines={1} style={[styles.workflowTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{workflow.name}</Text>
                                <Text style={[styles.elapsed, { color: theme.colors.textSecondary, ...Typography.mono() }]}>{formatWorkflowElapsed(workflow.startedAt, now)}</Text>
                            </View>
                            {workflow.description ? <Text style={[styles.description, { color: theme.colors.textSecondary, ...Typography.default() }]}>{workflow.description}</Text> : null}
                            {workflow.usage && (
                                <View style={styles.usageRow}>
                                    {workflow.usage.totalTokens !== undefined && <Text style={[styles.usage, { color: theme.colors.textSecondary }]}>{t('workflows.tokens', { count: formatWorkflowTokens(workflow.usage.totalTokens) })}</Text>}
                                    {workflow.usage.toolUses !== undefined && <Text style={[styles.usage, { color: theme.colors.textSecondary }]}>{t('workflows.toolCalls', { count: workflow.usage.toolUses })}</Text>}
                                    {workflow.usage.durationMs !== undefined && <Text style={[styles.usage, { color: theme.colors.textSecondary }]}>{formatWorkflowElapsed(0, workflow.usage.durationMs)}</Text>}
                                </View>
                            )}
                        </View>
                        {workflow.phases.map((phase) => {
                            const phaseState = getPhaseVisualState(phase);
                            const phaseStateText = stateLabel(phaseState);
                            return (
                                <View key={`${workflow.taskId}:${phase.index}`} accessibilityLabel={t('workflows.phaseAccessibility', { title: phase.title, state: phaseStateText })} style={[styles.phase, { borderColor: theme.colors.divider }]}>
                                    <View style={styles.phaseTitleRow}>
                                        <View style={[styles.phaseIndex, { backgroundColor: `${colorFor(phaseState)}1F` }]}><Text style={{ color: colorFor(phaseState), fontSize: 11 }}>{phase.index < 0 ? '•' : phase.index}</Text></View>
                                        <Text numberOfLines={2} style={[styles.phaseTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]}>{phase.index < 0 ? t('workflows.otherPhase') : phase.title}</Text>
                                        <Text style={[styles.state, { color: colorFor(phaseState) }]}>{phaseStateText}</Text>
                                    </View>
                                    {phase.agents.map((agent) => {
                                        const visual = normalizeWorkflowAgentState(agent.state);
                                        const visualText = stateLabel(visual);
                                        return (
                                            <View key={agent.id} accessibilityLabel={t('workflows.agentAccessibility', { label: agent.label, state: visualText })} style={[styles.agent, { borderColor: theme.colors.divider }]}>
                                                <View style={styles.agentRow}>
                                                    <View style={[styles.dot, { backgroundColor: colorFor(visual) }]} />
                                                    <Text numberOfLines={1} style={[styles.agentLabel, { color: theme.colors.text, ...Typography.default() }]}>{agent.label}</Text>
                                                    {agent.model ? <Text numberOfLines={1} style={[styles.model, { color: theme.colors.textSecondary, ...Typography.mono() }]}>{agent.model}</Text> : null}
                                                    <Text style={[styles.srState, { color: colorFor(visual) }]}>{visualText}</Text>
                                                </View>
                                                {(agent.lastToolName || agent.lastToolSummary) && <Text numberOfLines={2} style={[styles.tool, { color: theme.colors.textSecondary, backgroundColor: theme.colors.surface, ...Typography.mono() }]}>{[agent.lastToolName, agent.lastToolSummary].filter(Boolean).join(' · ')}</Text>}
                                            </View>
                                        );
                                    })}
                                </View>
                            );
                        })}
                    </View>
                ))}
                <Text style={[styles.footer, { color: theme.colors.textSecondary, ...Typography.default() }]}>{t('workflows.dismissAutomatically')}</Text>
            </ScrollView>
        </View>
    );
});
```

Append these styles in the same file. Keep the default panel scannable: do not add prompt or result previews.

```tsx
const styles = StyleSheet.create(() => ({
    root: { flex: 1, borderLeftWidth: StyleSheet.hairlineWidth },
    header: {
        height: 54,
        paddingHorizontal: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    headerTitle: { fontSize: 15, lineHeight: 20 },
    headerCount: { fontSize: 11, lineHeight: 14, marginTop: 2 },
    content: { padding: 12, gap: 12 },
    card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
    workflowHeader: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    workflowTitle: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19 },
    elapsed: { marginLeft: 'auto', fontSize: 11 },
    description: { marginTop: 6, marginLeft: 14, fontSize: 12, lineHeight: 17 },
    usageRow: { marginTop: 9, marginLeft: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    usage: { fontSize: 11 },
    phase: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    phaseTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    phaseIndex: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    phaseTitle: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 },
    state: { marginLeft: 'auto', fontSize: 11 },
    agent: { marginTop: 10, marginLeft: 8, paddingLeft: 14, borderLeftWidth: StyleSheet.hairlineWidth },
    agentRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    agentLabel: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17 },
    model: { marginLeft: 'auto', maxWidth: '38%', fontSize: 10 },
    srState: { fontSize: 10 },
    tool: { marginTop: 7, padding: 8, borderRadius: 6, fontSize: 10, lineHeight: 14 },
    footer: { textAlign: 'center', fontSize: 12, lineHeight: 17, paddingVertical: 2 },
}));
```

- [ ] **Step 5: Typecheck the components and translations**

```powershell
pnpm --filter happy-app typecheck
```

Expected: exit 0. The exhaustive `stateLabel` switch keeps translation keys statically typed without an `any` cast.

- [ ] **Step 6: Commit the approved visual components**

```powershell
git add packages/happy-app/sources/components/workflows packages/happy-app/sources/text
git commit -m "feat(app): add active workflow monitor UI"
```

### Task 5: Wire responsive opening, ephemeral desktop state, and the mobile route

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx:80-180,360-540`
- Create: `packages/happy-app/sources/app/(app)/session/[id]/workflows.tsx`
- Modify: `packages/happy-app/sources/app/(app)/_layout.tsx:79-117`
- Test: `packages/happy-app/sources/components/workflows/workflowModel.test.ts`

- [ ] **Step 1: Re-run the pure interaction tests before wiring UI**

```powershell
pnpm --filter happy-app exec vitest run sources/components/workflows/workflowModel.test.ts
```

Expected: PASS, including no auto-open on workflow detection, explicit open/close, wide-panel versus route selection, and final-removal dismissal. These functions are the testable interaction contract used directly by `SessionView` and the route.

- [ ] **Step 2: Add workflow imports and derive active-only state in `SessionView`**

Add these imports:

```ts
import { WorkflowActivityBadge } from '@/components/workflows/WorkflowActivityBadge';
import { WorkflowPanel } from '@/components/workflows/WorkflowPanel';
import {
    canUseWorkflowContextPanel,
    reduceWorkflowPanelOpen,
    resolveWorkflowOpenTarget,
    selectActiveWorkflows,
} from '@/components/workflows/workflowModel';
```

After `windowWidth`, derive the display array and ephemeral open state. This state must remain local to `SessionView`; do not add a `SidebarMode`, local setting, or persistence field:

```ts
const activeWorkflows = React.useMemo(
    () => selectActiveWorkflows(session?.agentState?.activeWorkflows),
    [session?.agentState?.activeWorkflows],
);
const [workflowPanelOpen, dispatchWorkflowPanel] = React.useReducer(reduceWorkflowPanelOpen, false);
const canShowWorkflowContextPanel = canUseWorkflowContextPanel({
    platform: Platform.OS,
    isMacDesktop: isRunningOnMac(),
    width: windowWidth,
    ready: isDataReady,
    hasSession: !!session,
});

React.useEffect(() => {
    dispatchWorkflowPanel({ type: 'active-count', count: activeWorkflows.length });
}, [activeWorkflows.length]);

React.useEffect(() => {
    dispatchWorkflowPanel({ type: 'close' });
}, [sessionId]);

React.useEffect(() => {
    if (!canShowWorkflowContextPanel) dispatchWorkflowPanel({ type: 'close' });
}, [canShowWorkflowContextPanel]);

const openWorkflowMonitor = React.useCallback(() => {
    if (resolveWorkflowOpenTarget(canShowWorkflowContextPanel) === 'context-panel') {
        dispatchWorkflowPanel({ type: 'open' });
    } else {
        router.push(`/session/${sessionId}/workflows`);
    }
}, [canShowWorkflowContextPanel, router, sessionId]);
```

There is deliberately no effect that dispatches `open` when the count changes from zero to one.

- [ ] **Step 3: Generalize the right-side width animation without tying workflows to Files capability**

Keep the existing `canShowSidebar` expression for Files exactly as-is. Replace the current `showSidebar` calculation and animation dependency with:

```ts
const showFilesSidebar = canShowSidebar && !zenMode;
const showWorkflowPanel = canShowWorkflowContextPanel
    && workflowPanelOpen
    && activeWorkflows.length > 0
    && !zenMode;
const showContextPanel = showWorkflowPanel || (!workflowPanelOpen && showFilesSidebar);
const hasDesktopContextArea = canShowSidebar || canShowWorkflowContextPanel;

const sidebarAnim = useSharedValue(showContextPanel ? 1 : 0);
React.useEffect(() => {
    sidebarAnim.value = withTiming(showContextPanel ? 1 : 0, {
        duration: Platform.OS === 'web' ? 0 : 250,
        easing: Easing.out(Easing.cubic),
    });
}, [showContextPanel]);
```

This preserves Files settings/capability checks for Files only. A native Claude workflow can open the right context area even if `fileDiffsSidebar` is off or the rig cannot browse files.

- [ ] **Step 4: Compose the badge into every available session header**

Rename the existing avatar node to `avatarHeaderRight`, then compose the badge with either the file-overlay controls or avatar:

```tsx
const avatarHeaderRight = session && deviceType === 'phone' && Platform.OS !== 'web'
    ? (
        <Pressable onPress={() => router.push(`/session/${sessionId}/info`)} hitSlop={10}>
            <Avatar
                id={getSessionAvatarId(session)}
                size={28}
                monochrome={!headerProps.isConnected}
                flavor={session.metadata?.flavor}
                clientId={session.metadata?.client?.id}
            />
        </Pressable>
    )
    : null;

const workflowBadge = activeWorkflows.length > 0
    ? <WorkflowActivityBadge count={activeWorkflows.length} onPress={openWorkflowMonitor} />
    : null;
const contextualHeaderRight = diffViewOpen || !!fileViewPath ? headerRightSlot : avatarHeaderRight;
const composedHeaderRight = workflowBadge || contextualHeaderRight
    ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{workflowBadge}{contextualHeaderRight}</View>
    : null;
```

Pass `composedHeaderRight` to `ChatHeaderView.rightSlot`. For the existing phone-landscape branch where `ChatHeaderView` is suppressed, add this sibling after the header conditional so mobile landscape still has an entry point:

```tsx
{isLandscape && deviceType === 'phone' && workflowBadge ? (
    <View style={{ position: 'absolute', top: safeArea.top + 8, right: 12, zIndex: 1001 }}>
        {workflowBadge}
    </View>
) : null}
```

- [ ] **Step 5: Render the temporary panel in the existing right context area**

Change the early return to `if (!hasDesktopContextArea) return mainContent;`. Inside the animated right-side container, select the workflow panel without mutating Files panel settings:

```tsx
<Animated.View style={[{ minWidth: 0, alignSelf: 'stretch' }, animatedSidebarStyle]}>
    <View style={{ width: sidebarWidth, flex: 1 }}>
        {showWorkflowPanel ? (
            <WorkflowPanel
                workflows={activeWorkflows}
                onClose={() => dispatchWorkflowPanel({ type: 'close' })}
            />
        ) : canShowSidebar ? (
            <FilesSidebar
                sessionId={sessionId}
                selectedPath={sidebarPanelActive === 'changes' ? scrollToFile : sidebarPanelActive === 'allFiles' ? fileViewPath : null}
                onFilePress={handleSidebarFilePress}
                openPanels={sidebarPanelsOpen}
                activePanel={sidebarPanelActive}
                onOpenPanel={openSidebarPanel}
                onSelectPanel={selectSidebarPanel}
                onClosePanel={closeSidebarPanel}
                onAllFilesFilePress={handleAllFilesFilePress}
                sideChats={sideChats}
                activeSideChatId={activeSideChatId}
                onSelectSideChat={setActiveSideChatId}
                onCloseSideChat={closeSideChat}
                onCreateSideChat={createSideChat}
                canCreateSideChat={!!sideChatForkSource}
                creatingSideChat={creatingSideChat}
            />
        ) : null}
    </View>
</Animated.View>
```

When the user closes the workflow panel or the final workflow disappears, `workflowPanelOpen` becomes false and the unchanged `sidebarPanelsOpen`/`sidebarPanelActive` values make the prior Files panel reappear.

- [ ] **Step 6: Create the full-screen mobile/narrow-web route**

Create `workflows.tsx`:

```tsx
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { WorkflowPanel } from '@/components/workflows/WorkflowPanel';
import { selectActiveWorkflows, shouldDismissWorkflowRoute } from '@/components/workflows/workflowModel';
import { useIsDataReady, useSession } from '@/sync/storage';

export default React.memo(function WorkflowsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const ready = useIsDataReady();
    const session = useSession(id);
    const { theme } = useUnistyles();
    const workflows = React.useMemo(
        () => selectActiveWorkflows(session?.agentState?.activeWorkflows),
        [session?.agentState?.activeWorkflows],
    );

    React.useEffect(() => {
        if (ready && shouldDismissWorkflowRoute(workflows.length)) {
            router.replace(`/session/${id}`);
        }
    }, [id, ready, router, workflows.length]);

    if (!ready) {
        return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    }
    if (!session || workflows.length === 0) return null;
    return <WorkflowPanel workflows={workflows} showHeader={false} />;
});
```

Because the empty branch returns `null` while `router.replace` runs, an already-finished workflow never flashes an empty monitor.

- [ ] **Step 7: Register the route with normal session navigation chrome**

Add this screen immediately after `session/[id]/info` in `packages/happy-app/sources/app/(app)/_layout.tsx`:

```tsx
<Stack.Screen
    name="session/[id]/workflows"
    options={{
        headerShown: true,
        headerTitle: t('workflows.activeTitle'),
        headerBackTitle: t('common.back'),
    }}
/>
```

- [ ] **Step 8: Run focused app tests and typecheck**

```powershell
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts sources/components/workflows/workflowModel.test.ts
pnpm --filter happy-app typecheck
```

Expected: tests PASS and TypeScript exits with code 0. Manually inspect the code to confirm there is no assignment of `workflow` to `SidebarMode`, `sidebarPanelsOpen`, or `sidebarPanelActive`.

- [ ] **Step 9: Commit responsive integration**

```powershell
git --literal-pathspecs add -- 'packages/happy-app/sources/-session/SessionView.tsx' 'packages/happy-app/sources/app/(app)/_layout.tsx' 'packages/happy-app/sources/app/(app)/session/[id]/workflows.tsx'
git commit -m "feat(app): open workflow monitor responsively"
```

### Task 6: Compact the raw Claude `Workflow` tool call in chat

**Files:**
- Modify: `packages/happy-app/sources/components/tools/knownTools.spec.ts`
- Modify: `packages/happy-app/sources/components/tools/knownTools.tsx:57-80`

- [ ] **Step 1: Write the failing known-tool test**

Append to `knownTools.spec.ts`:

```ts
it('renders Claude Workflow as compact activity without exposing its script', () => {
    const workflow = (knownTools as Record<string, any>).Workflow;
    expect(workflow).toBeDefined();
    expect(workflow.hidden).not.toBe(true);
    expect(workflow.minimal).toBe(true);
    expect(workflow.title).toBe('workflows.toolTitle');
    expect(workflow.input.safeParse({
        script: 'export default workflow({ phases: [] })',
        future_field: true,
    }).success).toBe(true);
});
```

The existing `@/text` mock returns the translation key, making the title assertion deterministic.

- [ ] **Step 2: Run the test and verify the expected failure**

```powershell
pnpm --filter happy-app exec vitest run sources/components/tools/knownTools.spec.ts
```

Expected: FAIL because `knownTools.Workflow` is undefined.

- [ ] **Step 3: Register the compact tool descriptor**

Add this entry beside `Task` and `Agent` in `knownTools.tsx`:

```tsx
'Workflow': {
    title: t('workflows.toolTitle'),
    icon: ICON_TASK,
    minimal: true,
    input: z.object({
        script: z.string().optional(),
    }).passthrough(),
},
```

`ToolView` already guarantees that `minimal` tools do not render content, so the JavaScript remains out of the chat transcript while the launch activity itself stays visible. Do not mark the tool hidden: the user should still see that Claude launched a workflow.

- [ ] **Step 4: Run the known-tool test and app typecheck**

```powershell
pnpm --filter happy-app exec vitest run sources/components/tools/knownTools.spec.ts
pnpm --filter happy-app typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the transcript treatment**

```powershell
git add packages/happy-app/sources/components/tools/knownTools.tsx packages/happy-app/sources/components/tools/knownTools.spec.ts
git commit -m "feat(app): compact Claude Workflow tool calls"
```

### Task 7: Full verification and live protocol smoke test

**Files:**
- Verify all files changed in Tasks 1-6.
- Do not add generated Claude transcripts, authentication data, `.superpowers/` mockup files, or local app build artifacts to git.

- [ ] **Step 1: Run the complete CLI verification suite**

```powershell
pnpm --filter happy typecheck
pnpm --filter happy test
```

Expected: TypeScript exits 0; the CLI build completes; every unit project test passes.

- [ ] **Step 2: Run the complete app verification suite**

```powershell
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run
```

Expected: TypeScript exits 0 and every app test passes. Use `vitest run`, not the package's watch-mode `vitest` script.

- [ ] **Step 3: Inspect the final diff for protocol and persistence boundaries**

```powershell
git diff --check
git status --short
git diff --stat origin/main...HEAD
rg -n "activeWorkflows|WorkflowActivityBadge|WorkflowPanel|local_workflow" packages/happy-cli/src packages/happy-app/sources
```

Expected:

- `git diff --check` prints nothing.
- `activeWorkflows` appears only in CLI/app types, tracker/publication, schema/model, and monitor consumers.
- No server schema, database migration, or frozen session-envelope type is modified.
- `SidebarMode` remains exactly `'changes' | 'allFiles' | 'sideChat'`.
- The existing untracked `.superpowers/` browser mockups remain uncommitted.

- [ ] **Step 4: Build and install the development CLI for a live smoke test**

```powershell
pnpm --filter happy build
pnpm --filter happy cli:install
```

Expected: the local `happy` command points to the newly built CLI. This step changes only the developer's local CLI installation, not server state.

- [ ] **Step 5: Run one read-only native Workflow request through Happy**

Start a Happy Claude session in this repository and submit this exact request:

```text
Use Claude Code's native Workflow tool, not Task or Agent. Create a workflow named inspect-happy-packages with two ordered phases. In phase 1, use one agent to read only packages/happy-app/package.json. In phase 2, use one agent to read only packages/happy-cli/package.json. Do not edit files. Summarize the package names when both phases finish.
```

This invocation requires the developer's existing Claude authentication and consumes model usage. Verify, in order:

1. The normal chat shows only a compact `Workflow` launch activity; no JavaScript script is expanded.
2. A `1 workflow` badge appears without opening any panel automatically.
3. Pressing it opens the right context panel on a wide web/desktop layout and the full-screen route on mobile or web narrower than 1100 px.
4. The panel shows `inspect-happy-packages`, phase 1/phase 2, their nested agent, model, and latest `Read` tool summary.
5. Closing the panel leaves the badge visible and does not stop the workflow.
6. Reopening shows current progress, and multiple concurrent runs appear oldest first if the request is submitted twice.
7. On `task_notification`, the card, panel/route, and badge disappear immediately; mobile returns to `/session/[id]`.
8. The assistant's final package-name summary remains normal chat content.

- [ ] **Step 6: Verify restart cleanup without inventing workflow history**

Start a second read-only native workflow, stop the Claude runtime while it is active, and return to the session. Expected: runtime cleanup publishes an empty snapshot, the badge disappears, and no completed/cancelled history card is retained. A temporary app/network disconnect alone must not call reset or erase an otherwise running workflow.

- [ ] **Step 7: Record final evidence and commit only if verification caused an intentional correction**

If verification required a code correction, rerun the focused failing test plus both typechecks, then commit the correction with a message describing the actual fix. If no correction was needed, do not create an empty commit.

## Self-review results

- **Spec coverage:** Tasks 1-2 cover native-only detection, missing-start fallback, hierarchy retention/grouping, multiple workflows, terminal removal, 250 ms coalescing, encrypted agent state, and runtime cleanup. Tasks 3-5 cover malformed-state isolation, conditional badge, no auto-open, desktop/mobile surfaces, immediate surface dismissal, Files restoration, ordering, usage, current tool, and accessibility. Task 6 covers compact raw tool rendering. Task 7 covers full and live verification.
- **Non-goals preserved:** The plan adds no Task/Agent inference, server storage, workflow controls, transcript/journal reads, completed history, Rig/Codex/Gemini generalization, or `SidebarMode` value.
- **Type consistency:** CLI and app snapshots use the same `taskId`, `toolUseId`, `name`, `description`, `startedAt`, `updatedAt`, `usage`, `phases`, and nested agent property names. Provider `tool_uses` is normalized once to the public `usage.toolUses` field. UI visual states are exactly `running | completed | error | active` across model, tests, panel, and translations.
- **Placeholder scan:** Every created/modified file, command, expected result, event shape, public signature, route, and commit is named. There are no deferred implementation markers in the plan.

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-08-10-claude-native-workflow-monitor.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, and iterate quickly using `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute the tasks in this session in batches with review checkpoints using `superpowers:executing-plans`.
