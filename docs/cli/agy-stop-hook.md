# Optional AGY ACP background continuation

AGY 1.5.9 can return `end_turn` while a background command is still running.
Its native transcript subsequently records completion, but no further ACP
events arrive, including with a standalone ACP client. Happy cannot repair
that by keeping its spinner active. This optional compatibility layer uses
AGY's documented `Stop` hook **before** it returns `end_turn`.

## Enable / remove

Default **off**. Verified only with AGY **1.5.9** and **1.5.10** on Linux; Unix socket transport
also supports Unix hosts, but macOS has not had authenticated live validation.
Other AGY versions and Windows reject an explicit opt-in before prompting.

```sh
HAPPY_AGY_STOP_HOOK=1 happy agy
# Rollback, including when reconnecting to the same native conversation:
HAPPY_AGY_STOP_HOOK=0 happy agy --resume <native-session-id>
```

For app/web-launched sessions, set the variable in the **Happy daemon's**
environment and restart that daemon, then start/resume the session. Existing
session processes keep their environment. Installing a CLI build alone does
not enable this experiment. No web/server or Helm configuration is required
by this implementation.

## Behavior and boundaries

- One private temporary customization directory is added with `--add-dir` to
  each AGY process. User project/global hooks are never edited. Existing named
  hooks are merged by AGY; their own decisions remain outside Happy's control. A preexisting hook named
  `happy-acp-background` can disable this hook; that fails visibly as unconfirmed
  instead of overwriting the user's setting.
- The shipped Node command forwards only six lifecycle fields to a private
  Unix socket. The controller/runtime stays outside the added workspace.
  Prompts, transcript contents, credentials and tool output are not forwarded.
  Filesystem permissions provide privacy from other users, **not** a security
  boundary against tools running as the same OS user.
- Continue only for a validated `Stop`, matching conversation, `NO_TOOL_CALL`
  and `fullyIdle === false`. Cancellation, errors and native budget limits
  are never overridden. `continuationActive` is validated but is not a loop
  counter: AGY 1.5.9 reports false even during forced continuations.
- Each turn tracks Stop observations for its own conversation. A newer
  execution or a current idle observation withdraws an earlier continuation
  still waiting in backoff. An older idle report cannot confirm newer work.
- This compatibility hook requests at most **60** continuations per user request; at most **24** without newly
  completed work; at most **15 minutes** per stalled continuation streak (resetting when real work completes), checked
  at each Stop decision. Stalled continuations apply progressive backoff (**5s → 10s → … → 30s**) on the private control socket before returning `continue`, waking early as soon as an action tool (`run_command`, file edit/write, subagent delegation) completes over ACP or the turn is cancelled. These are continuation budgets, not a prompt timeout
  or a guaranteed token-cost ceiling. Completed status/wait tools (`manage_task`, `manage_subagents`, `schedule`) do not reset
  the no-progress allowance or wake an in-flight backoff early. An action
  reported as `failed` over ACP also leaves that allowance intact. The native model can still use tokens
  or wait within an invocation.
- No automatic new user prompt is sent. A hook `continue` still invokes the
  model again and may consume additional tokens. A single status check per wakeup is requested without creating redundant `schedule` timers; existing commands must not be rerun.
- Intentionally long-running servers/watchers cannot reliably be identified
  from `fullyIdle`. They receive the same bounded policy. A limit produces an
  explicit **unconfirmed completion / failed turn**, not a claim that the server
  was stopped or that the user's work finished. Disable the experiment for
  sessions whose normal workflow intentionally leaves tasks running.
- Missing, malformed or failed hooks never trigger an unbounded retry. A
  missing final valid observation is reported as unconfirmed. A permission
  rejection is reported without retrying or changing permissions; AGY may
  return immediately without running Stop in that case.
- Cancel invalidates the controller before the ACP cancellation request.
  On cancellation/error, its process and socket are retired. The next request
  loads the exact saved native session with a fresh configuration. Requests
  wait for cancellation cleanup. Replay and permission guards remain active.
- **Cancelling the agent does not guarantee native background command cleanup.**
  AGY commands can survive ACP process exit. Happy cannot safely infer and kill
  unrelated processes. Unresolved tool cards explicitly say the command may
  still be running. This patch does not claim to fix AGY process ownership.

## Independent rollback units

1. Completion reporting: unresolved ACP tools no longer produce a successful
   turn or a fabricated “interrupted” command outcome. No hook dependency.
2. Optional hook compatibility: `stopHook.ts`, `scripts/agy-stop-hook.cjs` and
   AGY backend wiring. Disable with `HAPPY_AGY_STOP_HOOK=0`, then remove this
   layer when a fixed AGY release is verified. It does not alter generic ACP,
   Codex, Claude, app UI schemas or the legacy print transport.
3. Authenticated verification script and evidence documentation.

## Verification

From `packages/happy-cli`, run the unit suite and `pnpm run typecheck`.
Authenticated probes require a logged-in AGY 1.5.9:

```sh
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-stop-hook.mts single
# Also: slow, chain, parallel, failure, denied, cancel, cancel-after-hook, watcher, hooks, broken-hook, collision
HAPPY_AGY_STOP_HOOK=1 pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-acp.mts
HAPPY_AGY_STOP_HOOK=1 pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-title.mts
```

The new probe approves only exact harmless fixture commands. Cancel/watcher
fixtures use self-terminating sleeps, without listeners or persistent writes;
disposal is not counted as proof of OS task termination. Retain the JSON result
and check `passed`, not just whether a CLI process exited.
