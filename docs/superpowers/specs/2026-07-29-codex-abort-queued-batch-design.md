# Codex Abort and Queued Batch Design

## Problem

When a Codex turn is active, Happy allows the user to queue additional prompts. Prompts with the same enhanced mode are intentionally combined into one newline-joined batch for the next Codex turn.

Pressing Escape should abort only the active turn. Instead, Codex can acknowledge `turn/interrupt`, emit a legacy completion for the active turn, and then emit a duplicate raw completion slightly later. The main loop can start the queued batch between those two completion events. Because the new turn does not yet have a provider turn ID, the delayed completion can resolve the new turn's completion promise. Happy then treats the queued batch as finished or aborted even though Codex may start it in the background.

## Requirements

- Escape aborts only the turn that was active when the abort was requested.
- Same-mode prompts queued during the active turn remain combined into one next-turn batch.
- The queued batch does not start until Happy's abort operation has fully settled.
- Duplicate terminal events from an older turn cannot resolve a newer turn.
- Fast Codex turns that omit `turn/started` continue to complete normally.
- Existing force-restart fallback behavior remains unchanged.

## Non-goals

- Do not change the app or server RPC contract.
- Do not make each queued prompt a separate turn.
- Do not add a fixed post-abort delay.
- Do not restart Codex after every successful interrupt.
- Do not refactor unrelated queue or session-protocol code.

## Considered Approaches

### Abort barrier plus idempotent terminal events

Wait for the in-progress abort operation before the app-server client starts another turn. In the same client, reject terminal events for a turn that has already completed before those events can touch the current pending completion.

This directly protects both boundaries involved in the failure: the consumer cannot overlap abort cleanup with the next turn, and the provider client cannot misapply a duplicate old event.

### Fixed delay after interrupt

Waiting briefly after every interrupt would probably absorb the observed one- or two-millisecond event delay. It would remain timing-dependent and could fail under load or on a slower transport.

### Restart app-server after every abort

A process restart would isolate old events, but it would add latency and make thread-resume failure part of every normal cancellation.

## Chosen Design

Use the abort barrier and idempotent terminal-event approach.

### App-server abort barrier

`CodexAppServerClient` will track the full `abortTurnWithFallback` operation, not only the shorter `turn/interrupt` RPC. A later `sendTurnAndWait` must await that operation before it creates a new pending completion or sends `turn/start`. The active `sendTurnAndWait` is still allowed to settle so the abort operation can observe its completion. Once abort recovery and cleanup finish, the queued batch may advance.

The queue itself is unchanged. `MessageQueue2.collectBatch()` continues joining consecutive, non-isolated items with the same mode hash.

### Terminal-event idempotence

`completedTurnIds` is the authoritative set of provider turn IDs that have already produced a terminal event. Terminal handling must consult this set before calling `tryResolvePendingTurn`.

The first terminal event for a turn continues to resolve the matching pending completion and emit the mapped Happy event. A later legacy or raw terminal event with the same turn ID is ignored entirely, even when a newer pending turn has not received its provider turn ID yet.

This preserves completion without `turn/started`: a terminal event for a previously unseen turn ID is still eligible to resolve the current pending completion.

## Event Flow

```text
active turn running
  -> queued prompts accumulate and retain batching behavior
  -> Escape starts abortInProgress and sends turn/interrupt
  -> first terminal event resolves the active turn
  -> the next sendTurnAndWait reaches the app-server abort barrier
  -> duplicate terminal events for the completed turn are ignored
  -> abort cleanup finishes
  -> main loop dequeues the combined queued batch
  -> next turn starts and owns its own completion
```

## Error Handling

- If interruption does not settle the active turn within the existing grace period, the existing force-restart and thread-resume path remains responsible for recovery.
- If abort cleanup throws, `handleAbort` retains its current logging and `finally` behavior; the app-server barrier is released when the tracked abort promise settles.
- Terminal events without a turn ID retain the current fallback behavior because they cannot be safely deduplicated by ID.

## Testing

Add two regression tests to `codexAppServerClient.test.ts`.

The abort-barrier test will:

1. Start an initial turn and begin `abortTurnWithFallback`.
2. Acknowledge `turn/interrupt` and settle the initial turn.
3. Request a follow-up turn before the abort operation returns.
4. Verify no second `turn/start` is sent until the abort operation settles.
5. Complete the follow-up and verify it resolves normally.

The duplicate-terminal test will emit this order:

1. Start an initial turn.
2. Acknowledge its interrupt immediately.
3. Emit its first terminal event so the initial wait settles.
4. Begin a follow-up `sendTurnAndWait`.
5. Emit a duplicate terminal event for the initial turn before the follow-up receives its turn ID.
6. Verify the follow-up is still pending.
7. Emit the follow-up completion and verify it resolves normally.

Run the focused Codex app-server client test, the Happy CLI unit test project, and TypeScript type checking before completion.
