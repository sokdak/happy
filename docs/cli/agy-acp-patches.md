# Antigravity ACP integration and removable fork patches

`happy agy` uses one `agy acp` stdio process and one native ACP session across
turns. It forwards public text/thought notifications and tool lifecycle events
through the existing Happy session protocol. The agent decides whether to emit
thoughts or progress text; the adapter does not manufacture them.

This patch stack is deliberately temporary and separable so the fork can adopt
an upstream implementation later. It changes no app or wire schemas, adds no
package dependencies, and leaves the generic `AcpBackend` unchanged.

## Runtime behavior

- Normal prompts have no print timeout or idle-based completion heuristic.
  Completion comes from the ACP `session/prompt` response.
- Initialize, session creation/loading and mode/model control requests have a
  30-second deadline. Failed or ambiguous control requests discard the process.
- Cancel sends `session/cancel`. If the turn has not settled in five seconds,
  the adapter terminates its process, escalating from SIGTERM to SIGKILL after
  one second. Shutdown also waits for process termination.
- After a disconnect, the current turn fails. The next user turn reconnects and
  loads the exact previous session ID. It never automatically replays an action
  that might already have executed. If loading fails, it does not silently
  create a fresh conversation.
- Session IDs come from ACP, never `last_conversations.json`. Native IDs are
  recorded in Happy metadata as `agySessionId` and in the CLI debug log.
- The ACP runner starts the existing loopback Happy MCP server and passes its
  stdio bridge on both session creation and loading. The first successful turn
  carries title instructions (including explicit resume); subsequent title
  updates are model-driven when the topic changes. `change_title` uses the
  existing Happy summary/metadata path. Reconnection routes calls to the current
  Happy client. Only exact title tool names/native labels are auto-approved;
  similarly named tools still require normal approval. Shutdown terminates the
  direct bridge process and closes the MCP server HTTP connections. Print mode
  retains its previous title behavior.
- Replayed history from `session/load` is suppressed to avoid duplicate messages.
- Text and supported thought deltas flush to Happy at most every 500 ms and
  before tool cards or turn completion. Other runners retain their old buffering
  behavior unless they opt into `flushPendingText()`.
- Models are selected by matching the agent's advertised ID or exact display
  name, including the fork's Gemini effort variants. Unknown models fail before
  prompting rather than silently running a different model.
- Image attachments are decrypted with the existing Happy attachment pipeline,
  paired with their own user message, checked by magic bytes, and passed as ACP
  image blocks. Supported formats are PNG/JPEG/GIF/WebP, at most 10 MiB each.
  A failed/unsupported image fails that message instead of sending a text-only
  prompt that would lose its context.
- Queued messages retain their own model, effort and permission selections,
  including while attachment downloads overlap. Offline-to-online reconnection
  rebinds input and approval handlers to the real session.
- Raw protocol payloads, stderr, tool output and edited file bodies are not
  logged or copied into tool cards. Tool cards show sanitized scalar arguments
  and start/end lifecycle; the current shared wire event has no tool-output body.

Verified with the installed Antigravity ACP Server **1.5.9**, on Ubuntu ARM64.
The adapter advertises no client filesystem/terminal capabilities: the agent
uses its own tools, as verified in the live test.

## Permission and configuration compatibility

| Happy selection | ACP behavior |
| --- | --- |
| `default`, `auto`, `safe-yolo` | `default`; requests raised by the agent go through Happy approval RPC |
| `acceptEdits` | `accept-edits`; the server permits workspace edits and requests approval for other gated operations |
| `plan`, `read-only` | `plan`; this is the agent's planning mode, not an OS filesystem sandbox |
| `yolo`, `bypassPermissions` | `default`; the adapter approves individual requests with `allow_once` |

No process-wide `--dangerously-skip-permissions` flag is used for ACP, so changing
back to a restrictive mode does not inherit a sticky bypass flag. Approvals,
including Happy's session-approval decision, select `allow_once`; cancel/disconnect
clears pending approval UI. The agent may perform operations that its own policy
does not gate without requesting client approval.

Models and modes use typed `session/set_model` and `session/set_mode` requests
with advertised string IDs. This `agy` path sends no `session/set_config_option`
request, avoiding the boolean-value incompatibility reported in
[upstream #1962](https://github.com/slopus/happy/issues/1962). This does not claim
to fix every third-party agent using Happy's separate generic ACP harness.

## Explicit resume and operational fallback

After installing a build containing these patches:

```sh
happy agy
happy agy --resume <native-ACP-session-id>
HAPPY_AGY_TRANSPORT=print happy agy
```

`--resume` creates a new Happy session around the explicitly selected native
conversation. It does not reopen the old Happy session's mobile entry. It is a
per-launch CLI option, not a daemon-wide environment variable that could make
unrelated sessions share a conversation.

ACP is the default. `HAPPY_AGY_TRANSPORT=print` explicitly selects the old
per-turn driver, with structured progress improvements. Print mode retains its
30-minute timeout, existing permission-flag behavior and cache fallback, and
rejects image input and explicit ACP resume. Invalid transport values fail.
There is no automatic transport fallback that might execute a prompt twice.

This PR does not publish a CLI, change the installed package or restart the
operator's daemon/active sessions. Installation and daemon rollout remain
separate from merging the code.

## Patch boundaries and upstream replacement

Preserve the commits with a merge commit or rebase merge. **Do not squash** this
stack if individual reverts are desired.

| Commit | Responsibility | Dependencies |
| --- | --- | --- |
| `e91413a` | Transport-independent tool-card mapping and diagnostic redaction, with tests (`toolDisplay.*`) | None |
| `6aca0d1` | Structured progress for the existing print adapter (`streamJson.*`, `AgyBackend.*`, `cliArgs.*`) | Mapping |
| `0f435d6` | Opt-in text flush method and its tests in `AcpSessionManager` | None; no behavior change for other callers |
| `5533224` | Isolated persistent ACP engine, protocol/lifecycle tests and opt-in live probe | Mapping; live probe also uses the flush method |
| `23bac14` | Happy title MCP, first-turn instructions, reconnect-safe session forwarding, exact title approvals and lifecycle tests/live probe | ACP engine and runtime integration |
| `8cf5843` | Switch `runAgy` to ACP, Happy permissions/images/queue/shutdown integration, explicit CLI resume, metadata ID, explicit print fallback | Mapping, ACP engine, flush method |

Title integration can be removed independently with `git revert 23bac14`.
Its only shared-server changes narrow the required client interface and close
remaining HTTP connections on stop; the existing summary handler is reused.

The print parser is not imported by the ACP engine. Reverting just `6aca0d1`
leaves ACP functioning and restores the original plain-text print fallback.
This combination was typechecked in a disposable worktree.

To return to improved print mode in code while waiting for an upstream ACP
replacement, revert the runtime integration first, then the unused engine:

```sh
git revert 23bac14 8cf5843 5533224
```

To remove the entire code stack before adopting the upstream implementation,
revert dependents before their foundations:

```sh
git revert 23bac14 8cf5843 5533224 0f435d6 6aca0d1 e91413a
```

The full sequence was checked in a disposable worktree and restores the exact
pre-stack tracked tree (`f937489`). These commands apply to this PR's tree;
later overlapping edits or rebased/squashed commit IDs need corresponding
resolution. This documentation can be removed separately once the migration is
complete. The previously merged timeout PR #37 is outside this stack and is not
reverted by these commands.

As of 2026-11-15, upstream progress PRs
[#1742](https://github.com/slopus/happy/pull/1742) and
[#1709](https://github.com/slopus/happy/pull/1709) are open. Compare the actual
upstream behavior before replacement; similar PR titles do not imply equivalent
session, approval, cancellation or resume semantics.

## Validation

From `packages/happy-cli`:

```sh
pnpm exec vitest run --project unit src/agy/ src/agent/acp/AcpSessionManager.test.ts
pnpm run typecheck
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-acp.mts
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-title.mts
```

The unit/wire suite covers 126 cases, including shared mapper regressions,
continuous text delivery, permission allow/deny/pending-abort, explicit session
loading and replay suppression, model/mode requests, unsupported inputs,
control timeouts, spawn failure, disconnect recovery without prompt replay,
cooperative/uncooperative cancellation, forced process cleanup, image ownership,
FIFO settings and offline reconnection.

The authenticated live probe uses a temporary fixture workspace and real `agy`
credentials already installed on the host. It verifies text before completion,
Read/Bash cards, multi-turn context, explicit resume after process restart,
model switching, red-image interpretation, cancellation and a successful next
turn. It prints event types/timing only, not credentials, image contents, prompt
responses or arbitrary tool output. It consumes provider requests and is opt-in,
not part of the default unit suite. The observed six-turn run passed in about
42 seconds. This is real ACP/Happy-envelope validation, not a physical-phone UI
test.

The separate title live probe verifies automatic initial title generation from
an ordinary gardening question, an explicit topic/title change, and title
updates after explicit resume, using real `agy acp` and the real Happy MCP
server/bridge in default permission mode. It records fixture summaries through
a local test client, without connecting to the production Happy API. All three
scenarios passed, and the probe exited normally with no remaining bridge child.
The MCP endpoint test also verifies routing after a Happy client swap.
