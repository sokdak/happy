# AGY ACP background follow-up and Stop-hook modes

## Version behavior

### AGY 1.5.10 and later stable 1.5.x releases

AGY 1.5.10+ fixes [#1461](https://github.com/google-antigravity/antigravity-cli/issues/1461) by delivering background task completions, reactive wakeup responses, tool updates, and `session/request_permission` requests over the existing ACP session **after** the initial `session/prompt` returns `end_turn`.

AGY 1.5.14 still negotiates **ACP v1 (`protocolVersion: 1`)**, which has no standard session-level `running` / `idle` state notification after reactive wakeups.

- On ACP v1 stdout alone, `tools.size === 0` occurs mid-chain (for example, between a background command finishing and a follow-up tool or final answer, or immediately when `invoke_subagent` / `schedule` launches), and no second `end_turn` is emitted when a reactive wakeup ends.
- Happy enables native post-turn events and uses an **observer-only `Stop` hook** on Unix by default. The hook returns `{}` and reads `fullyIdle` and `terminationReason` at the initial `end_turn` and after each reactive wakeup.

### AGY 1.5.9 (bounded forced continuation on Unix)

AGY 1.5.9 does not deliver post-`end_turn` ACP updates unless kept inside `session/prompt`. On Unix hosts, Happy automatically selects bounded forced continuation (`mode=continue`) for AGY 1.5.9 (unless opted out with `HAPPY_AGY_STOP_HOOK=0`).

### Versions outside the supported range

On Unix, automatic hook selection reports a startup error for AGY 1.6.0 and later, prereleases, and missing or unrecognized versions. The error shows the supported range and the `HAPPY_AGY_STOP_HOOK=0` override for basic ACP sessions. Extending the range to a new release line requires checking the hook and post-turn lifecycle contract.

Automatic mode still uses basic ACP for stable versions older than 1.5.9. Explicit hook modes require AGY 1.5.9 or later within the stable 1.5.x line, with observer mode requiring 1.5.10 or later.

## Configuration and rollback switches

```sh
# Default on Unix with stable AGY >=1.5.10 <1.6.0: observe Stop events.
happy agy

# Disable the Happy Stop hook. Post-end_turn updates, permissions, and cancel still work on supported 1.5.x releases from 1.5.10 onward,
# while unresolved foreground non-daemon tools report unconfirmed overall completion.
HAPPY_AGY_STOP_HOOK=0 happy agy

# Explicit observer-only mode on stable AGY >=1.5.10 <1.6.0.
HAPPY_AGY_STOP_HOOK=observe happy agy

# Force the version's default hook mode.
HAPPY_AGY_STOP_HOOK=1 happy agy

# Explicit legacy forced continuation on stable AGY >=1.5.9 <1.6.0.
HAPPY_AGY_STOP_HOOK=continue happy agy
```

For daemon-launched web/mobile sessions, set any override in the **Happy daemon** environment and restart the daemon before starting or resuming a session. Existing running session processes keep their launch environment.

## Behavior and boundaries

- **Privacy & isolation**: One private `0700` temporary customization directory is passed via `--add-dir` per AGY process. User/workspace/global `.agents/hooks.json` files are never modified. `scripts/agy-stop-hook.cjs` forwards only six lifecycle fields (`conversationId`, `hookEventName`, `executionNum`, `terminationReason`, `fullyIdle`, `continuationActive`) over a private Unix domain socket; prompts, transcripts, tool outputs, and secrets are never forwarded. Stop events emitted by child subagents (`conversationId` different from the active ACP session) are ignored without poisoning the parent turn.
- **Progress accounting**: Only `completed` action/delegation tools (`run_command`, file edits/writes, `invoke_subagent`, `send_message`, `swarm`, `run_workflow`) count as progress; `failed` actions and status/inspection tools (`manage_task`, `manage_subagents`, `schedule`, `read_file`) do not reset stalled allowances or deadlines.
- **Late permissions**: Post-`end_turn` `session/request_permission` requests are routed through Happy's normal permission handler (`allow_once` / `reject_once`) and paired onto the matching tool card. When a reactive-wakeup permission request is denied and AGY 1.5.10 skips invoking `Stop`, Happy fails the turn deterministically after a bounded settle window instead of hanging.
- **Daemons and long-running watchers**: Commands or schedules marked `IsDaemon: true` report `fullyIdle: true` in AGY 1.5.10; Happy settles their UI card cleanly (`Background daemon continues running.`) without failing the turn or killing the daemon. Non-daemon tasks that keep `fullyIdle: false` remain bounded by `maxContinuationMs` (15 minutes without action-tool progress), reporting unconfirmed completion and retiring the wedged ACP process so the next turn reloads the saved session cleanly rather than hanging on stale `fullyIdle: false` state or claiming false completion. For sessions that intentionally leave non-`IsDaemon` tasks running across turns, set `HAPPY_AGY_STOP_HOOK=0`.
- **User questions (`ask_question`)**: When AGY pauses on `ask_question` (returning `end_turn` without invoking `Stop` on a foreground turn, or settling on `status: "pending"` without invoking `Stop` during a post-`end_turn` reactive wakeup), Happy recognizes the confirmed `status: "pending"` pause when no other non-daemon tools or permission prompts remain open, keeps the `agy acp` process and background context alive, renders an interactive `RequestUserInputCard` (supporting single-select and `is_multi_select` option selection inline across Web, iOS, and Android, inline custom text input on Web, and free-form composer replies across all clients), and settles the question lifecycle cleanly when answered on the next turn or cancelled.
- **Cancellation**: Calling abort/cancel during or after initial `end_turn` sends `session/cancel` over ACP, aborts pending permission prompts, drains cooperative `tool_call_update(failed)` notifications within `cancelGraceMs`, closes any remaining tool cards as unconfirmed, and fences late events/approvals. AGY 1.5.10 terminates standard background commands on `session/cancel`, though detached OS child processes outside AGY's process group remain subject to OS process boundaries.

## Independent rollback units (for upstream ACP v2 migration)

1. **Commit 1 — Post-`end_turn` ACP backend lifecycle (`AgyAcpBackend.ts`)**: Separates foreground `session/prompt` RPC lifetime from session event/permission/cancel lifetime on AGY 1.5.10, tracks `IsDaemon` and cross-turn tool ownership.
2. **Commit 2 — Happy turn & tool-card runner wiring (`AcpSessionManager.ts`, `runAgy.ts`)**: Opt-in `allowPostTurnFollowups` preserves CUID2 tool-call IDs across turn boundaries and flushes post-turn step output onto valid `turn`-scoped `SessionEnvelope`s without affecting other ACP agents.
3. **Commit 3 — Observer-only `Stop` hook on AGY 1.5.10 (`stopHook.ts`, `AgyAcpBackend.ts`, docs/scripts)**: Replaces forced `continue` with `{}` `fullyIdle` observation on AGY 1.5.10. When upstream AGY ships ACP v2 `running` / `idle` session notifications, revert **Commit 3** first (and remove `stopHook.ts` once AGY 1.5.9 compatibility is retired) while keeping Commits 1 and 2.

## Verification

From `packages/happy-cli`:

```sh
pnpm exec vitest run --project unit src/agy src/agent/acp/AcpSessionManager.test.ts src/agent/acp/runAcp.test.ts
pnpm run typecheck

# Authenticated live AGY 1.5.10 verification (uses disposable fixture workspaces and approves only exact harmless fixture commands):
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-1510-followup.mts all
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-acp.mts
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-title.mts
```
