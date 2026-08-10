# Claude Native Workflow Monitor Design

## Goal

Show Claude Code's currently running native workflows in Happy, grouped by the same workflow, phase, and agent boundaries that Claude Code emits. A session-header badge appears only while at least one workflow is active. The user opens the monitor explicitly by pressing the badge. Completed, failed, or cancelled workflows disappear immediately rather than becoming a second workflow history.

The feature covers web, desktop, and mobile. Web and desktop use the session's right context area. Mobile and narrow web layouts use a full-screen session route.

## Scope

This work spans `happy-cli`, the encrypted per-session agent state, and `happy-app`:

- capture Claude Code native workflow lifecycle messages in the CLI;
- normalize those messages into a small active-only snapshot;
- synchronize the snapshot through the existing encrypted agent-state channel;
- render an activity badge and a responsive workflow monitor;
- remove terminal workflows immediately; and
- render the low-level `Workflow` tool call compactly so its JavaScript input is not dumped into chat.

No server database or API endpoint is added. The server continues to treat agent state as an opaque encrypted value.

## Non-Goals

- Treating `Task` or `Agent` tool calls as native workflows.
- Inferring workflows from adjacent tool calls or chat text.
- Keeping completed workflow history.
- Reading Claude's local workflow transcript, journal, script, or output files from the app.
- Adding workflow controls such as stop, resume, retry, or edit.
- Generalizing the UI to Rig, Codex, Gemini, or arbitrary background tasks in this change.
- Replacing the existing `TaskView` sidechain rendering.

## Empirical Claude Code Protocol Findings

The design was validated against the locally installed Claude Code 2.1.220 by invoking `claude -p --output-format stream-json --verbose --forward-subagent-text` with a request that explicitly required the native `Workflow` tool.

The initialization event advertised `Workflow` as a built-in tool alongside `Task`, `TaskCreate`, `TaskUpdate`, and the other Claude tools. The executed workflow used a script with `meta.name`, `meta.description`, `meta.phases`, `phase(...)`, and `agent(...)` calls.

The observed lifecycle was:

1. An assistant `tool_use` block invoked `Workflow` with the script.
2. `background_tasks_changed` announced a task whose `task_type` was `local_workflow`.
3. `task_started` supplied `task_id`, `tool_use_id`, `workflow_name`, `description`, `task_type`, and the script in `prompt`.
4. The `Workflow` tool result immediately reported "Workflow launched in background". This completed the tool call but not the workflow.
5. Repeated `task_progress` events supplied usage, summary, current description, and occasional full `workflow_progress` snapshots.
6. `background_tasks_changed` removed the workflow from its active task list.
7. `task_updated` marked the task completed.
8. `task_notification` supplied the terminal status and final usage.

The key `workflow_progress` entries observed were:

```ts
type WorkflowProgressEntry =
    | {
        type: 'workflow_phase';
        index: number;
        title: string;
    }
    | {
        type: 'workflow_agent';
        index: number;
        label: string;
        phaseIndex: number;
        phaseTitle: string;
        agentId: string;
        model?: string;
        state: string; // observed: "start", "done"
        queuedAt?: number;
        startedAt?: number;
        attempt?: number;
        promptPreview?: string;
        lastToolName?: string;
        lastToolSummary?: string;
        lastProgressAt?: number;
        tokens?: number;
        toolCalls?: number;
        durationMs?: number;
        resultPreview?: string;
    };
```

Not every `task_progress` event includes `workflow_progress`. Events without it are usage/heartbeat deltas, not instructions to erase the previous hierarchy.

The existing Happy pipeline already receives these SDK system messages in remote mode. `sdkToLogConverter` preserves them, but `mapClaudeLogMessageToSessionEnvelopes` currently drops every `system` message. A running workflow therefore cannot be derived from the app's message list. The immediate successful `Workflow` tool result also proves that tool-call state cannot represent the background workflow lifecycle.

## User Experience

### Entry point

The session header displays a compact pulsing badge such as `1 workflow` or `2 workflows` when active workflows exist. The badge is absent when the active set is empty. Detection never opens the monitor automatically.

Pressing the badge:

- opens the right context panel on web and desktop layouts that have room for it;
- opens `/session/[id]/workflows` on mobile and narrow web layouts; and
- focuses the monitor if it is already open.

The user may close the monitor while work continues. The badge remains available. When the final active workflow terminates, the badge disappears and an open monitor closes automatically. Mobile returns to the session chat rather than showing an empty monitor.

### Desktop context area

The workflow monitor temporarily occupies the existing right context area. It is ephemeral and is not added to the device-persisted `SidebarMode` list. This avoids restoring a completed workflow panel after reload. If a Files sidebar panel was visible before the workflow monitor opened, closing or auto-closing the monitor reveals that existing panel again.

Workflow availability is independent of the file-diff sidebar preference and file/shell capabilities. A Claude workflow can therefore be inspected even when Files panels are disabled or unavailable.

### Monitor content

Each running workflow card shows:

- workflow name, falling back to description and then `Workflow`;
- description;
- elapsed time;
- total token, tool-use, and duration usage when reported;
- ordered phases; and
- agents nested under their `phaseIndex`.

Each agent row shows its label, model, normalized visual state, and the latest tool name/summary. Additional details such as prompt or result previews remain out of the default monitor to keep the active view scannable.

The phase/agent hierarchy follows Claude's emitted indices. Happy does not invent steps from normal chat tools. Multiple active workflows are ordered by start time, oldest first, so cards do not jump as progress arrives.

### Chat transcript

The low-level `Workflow` tool call is registered as a known compact activity tool. Its JavaScript script is not expanded into the chat by default. Its completion means the background workflow was launched successfully, not that the workflow finished; the active monitor owns the actual lifecycle display. Claude's final assistant summary remains normal chat content.

## Architecture

### Data flow

```text
Claude SDK stream
  -> ClaudeWorkflowTracker (happy-cli)
  -> active workflow snapshot
  -> ApiSessionClient.updateAgentState(...)
  -> encrypted session agentState
  -> useSession(sessionId)
  -> WorkflowActivityBadge + WorkflowPanel / mobile route
```

Workflow system messages remain hidden from the conversation transcript. The frozen session-message protocol is not extended for transient workflow state.

### CLI tracker

Add a focused Claude workflow tracker with a pure reducer and a thin publisher. The pure reducer accepts unknown SDK messages and returns whether the active snapshot changed. It tracks workflows by Claude `task_id`.

Only tasks identified as `task_type === 'local_workflow'` enter the active set. `Task`, generic background tasks, shell processes, and unknown task types are ignored.

Transitions:

- `background_tasks_changed`: reconcile the set of `local_workflow` task ids. Create a minimal entry from the task description if `task_started` has not arrived yet. Remove tracked workflows absent from the new background-task snapshot.
- `task_started`: create or enrich the entry with `workflow_name`, description, tool-use id, and the local receive time used as a fallback start time.
- `task_progress`: update summary, usage, and last activity. Replace the stored progress hierarchy only when a non-empty, valid `workflow_progress` snapshot is present.
- `task_updated`: remove the entry when the patch reports a terminal status.
- `task_notification`: remove the entry immediately because Claude emits notifications for terminal background-task results. Record no completed history.

The tracker groups flat `workflow_phase` and `workflow_agent` entries into phases. Agents with a missing or unknown phase are retained in an `Other` fallback phase rather than dropped. Phase and agent indices determine stable ordering.

The tracker accepts additive fields with passthrough schemas. Malformed individual progress entries are skipped. A malformed event never clears other active workflows.

### Agent-state snapshot

Extend the optional ephemeral agent state with an active-only field:

```ts
type ActiveWorkflowSnapshot = {
    taskId: string;
    toolUseId?: string;
    name: string;
    description?: string;
    startedAt: number;
    updatedAt: number;
    usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
    };
    phases: Array<{
        index: number;
        title: string;
        agents: Array<{
            id: string;
            index: number;
            label: string;
            model?: string;
            state: string;
            queuedAt?: number;
            startedAt?: number;
            lastToolName?: string;
            lastToolSummary?: string;
            lastProgressAt?: number;
            tokens?: number;
            toolCalls?: number;
            durationMs?: number;
        }>;
    }>;
};

type AgentState = {
    // existing fields...
    activeWorkflows?: Record<string, ActiveWorkflowSnapshot>;
};
```

The app schema treats this field as optional and catches malformed workflow snapshots independently, preserving permissions, usage limits, and goal state.

Progress publications are coalesced over 250 ms to avoid serializing a socket metadata update for every heartbeat. Start and removal transitions flush immediately. A pending progress timer is cancelled before a terminal removal so an older snapshot cannot resurrect the workflow.

The tracker clears `activeWorkflows` when a new Claude runtime starts and during runtime cleanup. This prevents a process that died without a terminal notification from leaving a stale badge. Normal app disconnects do not clear the state because the CLI and workflow may still be running; reconnecting devices should see the last live snapshot.

### App model and components

Keep state parsing separate from rendering:

- a pure model helper converts the optional agent-state record to a sorted array and maps provider state strings to visual states;
- `WorkflowActivityBadge` renders the conditional header entry point and count;
- `WorkflowPanel` renders the shared workflow/phase/agent hierarchy;
- the desktop session layout renders `WorkflowPanel` in the right context area when its ephemeral open flag is true; and
- the mobile route renders the same panel content inside normal session navigation chrome.

Known provider state mappings are:

- `start`, `running`, and `in_progress` -> running;
- `done`, `completed`, and `success` -> completed;
- `error` and `failed` -> error; and
- unknown strings -> neutral active styling while the parent workflow remains active.

Accessibility labels announce the active workflow count, phase title and state, and agent label and state. Status is never conveyed by color alone.

## Error Handling and Recovery

- Missing `workflow_name` falls back to description and then `Workflow`.
- A progress event without a hierarchy keeps the last valid hierarchy.
- A missing `task_started` can still produce a minimal card through `background_tasks_changed`.
- A terminal `task_notification`, terminal `task_updated`, or disappearance from `background_tasks_changed` removes the workflow.
- Multiple workflows are isolated by task id; a malformed event for one cannot clear another.
- A CLI restart clears stale workflow state before accepting new events.
- Older CLI versions that emit no native workflow lifecycle messages simply never populate `activeWorkflows`; the badge remains absent.
- If the mobile route is opened after the final workflow already ended, it immediately returns to the session instead of flashing an empty page.

## Testing

### CLI unit tests

Create sanitized fixtures from the verified Claude Code 2.1.220 stream and test the pure tracker before implementation:

- `background_tasks_changed` creates a minimal native workflow and ignores other task types;
- `task_started` enriches the same task without duplicating it;
- full progress groups phases and agents in index order;
- progress without `workflow_progress` preserves the prior hierarchy while updating usage;
- agent `start` to `done` updates in place;
- malformed progress entries are skipped without losing valid entries;
- concurrent workflows remain independent;
- terminal notification removes immediately;
- terminal task update removes when notification is absent;
- background-task reconciliation removes a missing workflow;
- cancelling a pending publication prevents workflow resurrection; and
- runtime reset clears stale snapshots.

Publisher tests use fake timers to verify 250 ms progress coalescing and immediate start/removal publication. `ApiSessionClient.updateAgentState` is mocked; no network is required.

### App unit and component tests

- malformed optional workflow state does not invalidate the rest of `AgentState`;
- active workflows sort stably by start time;
- provider states map to accessible visual states;
- zero workflows hides the badge;
- badge count handles one and multiple workflows;
- pressing the badge opens the desktop context panel or mobile route according to layout;
- phases contain the correct agents and latest tool details;
- manually closing the monitor leaves the badge visible while work continues;
- the last workflow removal closes the desktop monitor;
- the last workflow removal returns the mobile route to chat; and
- an already-empty mobile route returns without rendering an empty monitor.

### Integration verification

After unit and type checks, run the same read-only native workflow through the development CLI and verify:

1. the badge appears after `task_started`;
2. phase and agent rows update from live `workflow_progress` snapshots;
3. desktop and mobile surfaces render the same hierarchy;
4. closing the panel does not stop the workflow;
5. `task_notification` removes the card and badge immediately; and
6. the normal assistant completion summary remains in chat.

The live Claude invocation is a manual integration check because it requires authentication and incurs model usage. CI uses the captured protocol fixture.

## Success Criteria

- Happy detects only Claude Code native `local_workflow` tasks.
- The monitor mirrors Claude's emitted workflow, phase, and agent grouping without heuristics.
- No completed workflow remains in the monitor or synchronized active state.
- Detection never interrupts the user by opening UI automatically.
- The feature works on wide web/desktop and mobile/narrow layouts.
- Older clients and malformed optional workflow data degrade to no monitor rather than a broken session.
