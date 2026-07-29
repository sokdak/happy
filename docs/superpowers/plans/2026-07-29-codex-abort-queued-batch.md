# Codex Abort Queued Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Escape aborts only the active Codex turn while the existing same-mode queued batch starts normally after abort settlement.

**Architecture:** Keep `MessageQueue2` batching unchanged. Make `CodexAppServerClient` track the complete abort operation as a barrier for later `sendTurnAndWait` calls, and make provider terminal events idempotent by checking completed turn IDs before resolving the current pending turn.

**Tech Stack:** TypeScript, Vitest, Codex app-server JSON-RPC test process, pnpm workspace tooling

---

## File Map

- Modify `packages/happy-cli/src/codex/codexAppServerClient.ts`: own the full abort barrier and discard duplicate terminal events before they can resolve a newer turn.
- Modify `packages/happy-cli/src/codex/codexAppServerClient.test.ts`: reproduce the abort/start overlap and both legacy-to-raw and raw-to-legacy duplicate terminal sequences.
- Reference `docs/superpowers/specs/2026-07-29-codex-abort-queued-batch-design.md`: approved behavioral contract; no further edits expected.

### Task 1: Block follow-up turns until the full abort operation settles

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts:44-113,240-379`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts:54-78,235-246,1032-1076,1146-1165`

- [ ] **Step 1: Install the locked workspace dependencies**

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
```

Expected: exit code 0 and `pnpm --filter happy exec vitest --version` prints a Vitest version. Do not update the lockfile.

- [ ] **Step 2: Add a reusable abort-race test harness**

Add this helper below `waitFor` in `codexAppServerClient.test.ts`:

```typescript
function createAbortRaceHarness() {
    const requests: MockRpcMessage[] = [];
    let output: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;

    const process = createMockProcess({
        pid: 2201,
        onRequest: (msg, stdout) => {
            requests.push(msg);
            output = stdout;

            if (msg.method === 'thread/start' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-abort-race', path: '/tmp/thread-abort-race' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'readOnly' },
                            reasoningEffort: null,
                        },
                    });
                }, 0);
            }

            const turnStarts = requests.filter((request) => request.method === 'turn/start');
            if (msg.method === 'turn/start' && msg.id != null && turnStarts.length === 1) {
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-old' } } });
                    pushJsonLine(stdout, {
                        method: 'codex/event',
                        params: { msg: { type: 'task_started', turn_id: 'turn-old' } },
                    });
                }, 0);
            }

            if (msg.method === 'turn/interrupt' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                }, 0);
            }
        },
    });

    return {
        process,
        requests,
        push(payload: unknown) {
            if (!output) throw new Error('Mock app-server output is not ready');
            pushJsonLine(output, payload);
        },
        turnStarts() {
            return requests.filter((request) => request.method === 'turn/start');
        },
    };
}
```

- [ ] **Step 3: Write the failing abort-barrier test**

Add this test after the existing forced-restart abort tests:

```typescript
it('does not start a queued follow-up until abort fallback settles', async () => {
    const harness = createAbortRaceHarness();
    mockSpawn.mockImplementation(() => harness.process);

    const { CodexAppServerClient } = await import('./codexAppServerClient');
    const client = new CodexAppServerClient();

    await client.connect();
    await client.startThread({
        model: 'gpt-test',
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
    });

    const initialTurn = client.sendTurnAndWait('active turn', { turnTimeoutMs: 5000 });
    await waitFor(() => harness.turnStarts().length === 1);

    const abort = client.abortTurnWithFallback({
        gracePeriodMs: 1000,
        forceRestartOnTimeout: false,
    });
    await waitFor(() => harness.requests.some((request) => request.method === 'turn/interrupt'));

    harness.push({
        method: 'codex/event',
        params: { msg: { type: 'task_complete', turn_id: 'turn-old' } },
    });
    await expect(initialTurn).resolves.toEqual({ aborted: false });

    const followUp = client.sendTurnAndWait('queued batch', { turnTimeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.turnStarts()).toHaveLength(1);

    await expect(abort).resolves.toEqual({
        hadActiveTurn: true,
        aborted: true,
        forcedRestart: false,
        resumedThread: false,
    });
    await waitFor(() => harness.turnStarts().length === 2);

    const followUpRequest = harness.turnStarts()[1];
    harness.push({ id: followUpRequest.id, result: { turn: { id: 'turn-next' } } });
    harness.push({
        method: 'codex/event',
        params: { msg: { type: 'task_started', turn_id: 'turn-next' } },
    });
    harness.push({
        method: 'codex/event',
        params: { msg: { type: 'task_complete', turn_id: 'turn-next' } },
    });

    await expect(followUp).resolves.toEqual({ aborted: false });
    await client.disconnect();
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts -t "does not start a queued follow-up"
```

Expected: FAIL because the current client sends the second `turn/start` while `abortTurnWithFallback` is still settling; `harness.turnStarts()` has length 2 instead of 1.

- [ ] **Step 5: Add the full abort-operation barrier**

Add this result type after `PendingRequest` in `codexAppServerClient.ts`:

```typescript
type AbortTurnResult = {
    hadActiveTurn: boolean;
    aborted: boolean;
    forcedRestart: boolean;
    resumedThread: boolean;
};
```

Add the tracked operation beside `pendingInterrupt`:

```typescript
// Covers the complete interrupt, completion wait, and optional restart/resume.
private pendingAbort: Promise<AbortTurnResult> | null = null;
```

Turn the existing abort implementation into a private method, and make the public method single-flight:

```typescript
async abortTurnWithFallback(opts?: {
    gracePeriodMs?: number;
    forceRestartOnTimeout?: boolean;
}): Promise<AbortTurnResult> {
    if (this.pendingAbort) {
        return this.pendingAbort;
    }

    const operation = this.performAbortTurnWithFallback(opts).finally(() => {
        if (this.pendingAbort === operation) {
            this.pendingAbort = null;
        }
    });
    this.pendingAbort = operation;
    return operation;
}

private async performAbortTurnWithFallback(opts?: {
    gracePeriodMs?: number;
    forceRestartOnTimeout?: boolean;
}): Promise<AbortTurnResult> {
    const hadActiveTurn = this.hasPendingTurnCompletion();

    if (!hadActiveTurn) {
        return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
    }

    const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
    void this.interruptTurn({ timeoutMs: Math.max(1, gracePeriodMs) });

    const settled = await this.waitForTurnCompletion(gracePeriodMs);
    if (settled) {
        return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
    }

    const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
    if (!shouldForceRestart) {
        return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
    }

    logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
    const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
    if (this.pendingTurnCompletion) {
        this.eventHandler?.({
            type: 'turn_aborted',
            reason: 'interrupted',
            ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
            forced_restart: true,
        });
    }
    const resumedThread = await this.reconnectAndResumeThread();
    return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
}
```

At the beginning of `sendTurnAndWait`, before checking `pendingInterrupt`, add:

```typescript
// The interrupt RPC can acknowledge before the interrupted turn's terminal
// notifications and fallback cleanup settle. Do not expose a new pending turn
// to those stale events.
if (this.pendingAbort) {
    await this.pendingAbort;
}
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts -t "does not start a queued follow-up"
```

Expected: PASS with 1 test passed and no unhandled timeout.

- [ ] **Step 7: Commit the abort barrier**

```powershell
git add -- packages/happy-cli/src/codex/codexAppServerClient.ts packages/happy-cli/src/codex/codexAppServerClient.test.ts
git commit -m "fix(codex): wait for abort settlement before queued turn"
```

### Task 2: Prevent duplicate old terminal events from resolving the next turn

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts:319-353,1527-1557`

- [ ] **Step 1: Add a terminal-event test helper**

Add below `createAbortRaceHarness`:

```typescript
type TerminalProtocol = 'legacy' | 'raw';

function pushTerminalEvent(
    harness: ReturnType<typeof createAbortRaceHarness>,
    protocol: TerminalProtocol,
    turnId: string,
    status: 'completed' | 'cancelled',
) {
    if (protocol === 'legacy') {
        harness.push({
            method: 'codex/event',
            params: {
                msg: {
                    type: status === 'cancelled' ? 'turn_aborted' : 'task_complete',
                    turn_id: turnId,
                },
            },
        });
        return;
    }

    harness.push({
        method: 'turn/completed',
        params: {
            threadId: 'thread-abort-race',
            turn: { id: turnId, status, items: [], error: null },
        },
    });
}
```

- [ ] **Step 2: Write the failing cross-protocol duplicate tests**

Add this parameterized test after the abort-barrier test:

```typescript
it.each([
    { first: 'legacy' as const, duplicate: 'raw' as const },
    { first: 'raw' as const, duplicate: 'legacy' as const },
])('ignores a duplicate $duplicate terminal event after $first completion', async ({ first, duplicate }) => {
    const harness = createAbortRaceHarness();
    mockSpawn.mockImplementation(() => harness.process);

    const { CodexAppServerClient } = await import('./codexAppServerClient');
    const client = new CodexAppServerClient();

    await client.connect();
    await client.startThread({
        model: 'gpt-test',
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
    });

    const initialTurn = client.sendTurnAndWait('active turn', { turnTimeoutMs: 5000 });
    await waitFor(() => harness.turnStarts().length === 1);
    pushTerminalEvent(harness, first, 'turn-old', 'completed');
    await expect(initialTurn).resolves.toEqual({ aborted: false });

    const followUp = client.sendTurnAndWait('queued batch', { turnTimeoutMs: 5000 });
    let followUpSettled = false;
    void followUp.finally(() => {
        followUpSettled = true;
    });
    await waitFor(() => harness.turnStarts().length === 2);

    pushTerminalEvent(harness, duplicate, 'turn-old', 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(followUpSettled).toBe(false);

    const followUpRequest = harness.turnStarts()[1];
    harness.push({ id: followUpRequest.id, result: { turn: { id: 'turn-next' } } });
    pushTerminalEvent(harness, 'legacy', 'turn-next', 'completed');

    await expect(followUp).resolves.toEqual({ aborted: false });
    await client.disconnect();
});
```

- [ ] **Step 3: Run the duplicate tests and verify RED**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts -t "ignores a duplicate"
```

Expected: both cases FAIL because the duplicate old terminal event resolves `followUp`; `followUpSettled` is true.

- [ ] **Step 4: Reject duplicate raw completion before resolving pending state**

At the top of `emitRawTurnCompletion`, before `tryResolvePendingTurn`, add:

```typescript
if (turnId && this.completedTurnIds.has(turnId)) {
    logger.debug(`[CodexAppServer] Ignoring duplicate ${source} for completed turn ${turnId}`);
    return;
}
```

Keep the existing `completedTurnIds.add(turnId)` after the first completion resolves and before emitting its event.

- [ ] **Step 5: Reject duplicate legacy completion before emitting or resolving it**

In the `codex/event` branch of `handleNotification`, determine terminal state before calling `eventHandler`:

```typescript
const isTerminal = msg.type === 'task_complete' || msg.type === 'turn_aborted';
const terminalTurnId = isTerminal ? (msg.turn_id ?? msg.turnId ?? null) : null;
if (isTerminal && terminalTurnId && this.completedTurnIds.has(terminalTurnId)) {
    logger.debug(`[CodexAppServer] Ignoring duplicate codex/event/${msg.type} for completed turn ${terminalTurnId}`);
    return;
}
```

Then reuse `isTerminal` and `terminalTurnId` in the existing completion block:

```typescript
if (isTerminal) {
    if (terminalTurnId) {
        this.completedTurnIds.add(terminalTurnId);
    }
    this.tryResolvePendingTurn(
        msg.type === 'turn_aborted',
        terminalTurnId,
        `codex/event/${msg.type}`,
    );
    this._turnId = null;
}
```

- [ ] **Step 6: Run the duplicate tests and verify GREEN**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts -t "ignores a duplicate"
```

Expected: 2 tests passed. The follow-up remains pending until `turn-next` completes.

- [ ] **Step 7: Preserve completion when `turn/started` is omitted**

Add this characterization test after the duplicate-terminal test:

```typescript
it('completes an unseen turn without a turn/started notification', async () => {
    const proc = createMockProcess({
        pid: 2202,
        onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-fast', path: '/tmp/thread-fast' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'readOnly' },
                            reasoningEffort: null,
                        },
                    });
                }, 0);
            }

            if (msg.method === 'turn/start' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-fast' } } });
                    pushJsonLine(stdout, {
                        method: 'turn/completed',
                        params: {
                            threadId: 'thread-fast',
                            turn: { id: 'turn-fast', status: 'completed', items: [], error: null },
                        },
                    });
                }, 0);
            }
        },
    });
    mockSpawn.mockImplementation(() => proc);

    const { CodexAppServerClient } = await import('./codexAppServerClient');
    const client = new CodexAppServerClient();
    await client.connect();
    await client.startThread({
        model: 'gpt-test',
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
    });

    await expect(client.sendTurnAndWait('fast turn')).resolves.toEqual({ aborted: false });
    await client.disconnect();
});
```

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts -t "without a turn/started"
```

Expected: PASS, proving the duplicate filter does not restore the removed `started` gate.

- [ ] **Step 8: Run the complete app-server client test file**

Run:

```powershell
pnpm --filter happy exec vitest run --project unit src/codex/codexAppServerClient.test.ts
```

Expected: every test in the file passes with no timeout or unhandled rejection.

- [ ] **Step 9: Commit terminal-event idempotence**

```powershell
git add -- packages/happy-cli/src/codex/codexAppServerClient.ts packages/happy-cli/src/codex/codexAppServerClient.test.ts
git commit -m "fix(codex): ignore duplicate completed turn events"
```

### Task 3: Verify the complete Codex CLI change

**Files:**
- Verify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Verify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`
- Verify: `docs/superpowers/specs/2026-07-29-codex-abort-queued-batch-design.md`

- [ ] **Step 1: Run the full Happy CLI unit test project**

```powershell
pnpm --filter happy exec vitest run --project unit
```

Expected: all unit tests pass with zero failures.

- [ ] **Step 2: Run Happy CLI type checking**

```powershell
pnpm --filter happy typecheck
```

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 3: Run formatting and patch hygiene checks**

```powershell
git diff --check HEAD~2..HEAD
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` contains no uncommitted implementation files.

- [ ] **Step 4: Review the final diff against the approved invariants**

Run:

```powershell
git diff HEAD~2..HEAD -- packages/happy-cli/src/codex/codexAppServerClient.ts packages/happy-cli/src/codex/codexAppServerClient.test.ts
```

Confirm all five conditions:

1. `MessageQueue2` is unchanged and same-mode messages remain batched.
2. A new `sendTurnAndWait` waits for the full abort operation.
3. Forced restart and thread resume still execute inside the tracked abort operation.
4. Duplicate raw and legacy terminal events are checked before `tryResolvePendingTurn`.
5. A first completion for an unseen turn ID still resolves without requiring `turn/started`.

- [ ] **Step 5: Request code review and address Critical or Important findings**

Provide the reviewer with the approved spec, the two implementation commit SHAs, the focused test command, and the full unit/typecheck results. Re-run Steps 1-4 after any review-driven code change.
