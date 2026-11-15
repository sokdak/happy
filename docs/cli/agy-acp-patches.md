# Antigravity ACP integration and removable fork patches

`happy agy` uses one `agy acp` stdio process and one native ACP session across
turns. It forwards public text/thought notifications and tool lifecycle events
through the existing Happy session protocol. The agent decides whether to emit
thoughts or progress text; the adapter does not manufacture them.

The fork can replace these patches with an upstream implementation later.
The resume additions use optional app metadata/capability fields, change no wire
event schemas, add no package dependencies, and leave the generic `AcpBackend`
unchanged.

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
- Text and public thought deltas are buffered as contiguous segments until a
  tool/type boundary or turn completion. Exact whitespace is retained for AGY.
  Tool cards still arrive immediately; uninterrupted final prose arrives at
  completion. The former 500 ms flush created separate Markdown rows and broke
  syntax across chunks. Existing stored fragmented messages are not repaired.
- AGY public thought summaries have an accessible, initially collapsed Thinking
  toggle. Other agents retain their existing visibility.
- Generic ACP search calls use native argument schemas to distinguish web,
  filename and content search; unknown search calls remain generic.
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
  and start/end lifecycle. Optional wire result/isError fields carry only fixed
  failure/interruption status strings and explicit success/error flags, never raw
  tool output. Successful tools retain the existing empty-output state. Other
  runners retain previous behavior unless they opt into forwarding results.

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

`happy agy --resume <native-ACP-session-id>` without a Happy reconnect identity
creates a new Happy session around the explicitly selected native conversation.
Use app/web Resume or `happy resume <Happy-ID>` to reopen the existing entry. It is a
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

PR [#38](https://github.com/sokdak/happy/pull/38) was squash-merged as
`4d58169`. Its original transport, title and runtime commits are therefore one
baseline commit on `sokdak/main`; their original individual revert commands no
longer apply to main.

The resume work was also squash-merged: #39 is `05fd7fe`. Original
pre-squash resume commit hashes are not independent main-branch revert targets.
Preserve the output corrections using merge/rebase merge rather than squash:

| Commit | Responsibility |
| --- | --- |
| `e5227e5` | Complete Markdown segments and exact whitespace (AGY opt-in) |
| `64b8436` | Native search argument/name mapping |
| `b3fb4bb` | Safe failed/interrupted tool status (optional protocol fields) |
| `e415d04` | Collapsed AGY public Thinking UI |
| `1046e40` | Legacy optimistic prompt order under device clock skew |
| Follow-up validation commit | Dark-theme chevron, regression fixtures, live probe and this guide |

Revert the validation follow-up first, then `1046e40`, `e415d04`, `b3fb4bb`, `64b8436`,
and `e5227e5` to restore the #39 baseline. Search mapping and Thinking are
independent features; selective reverts may need context resolution in adjacent
tests or follow-up edits. Failure-status and Markdown touch the same manager/runner,
so use reverse order when removing the full stack.
If upstream replaces the complete integration, remove this output stack before
`05fd7fe` (resume) and `4d58169` (ACP/title). The timeout fix #37 is separate.
Compare upstream session identity, approvals, cancellation, resume and output
behavior before replacement; overlapping later edits may need resolution.

## Validation

From `packages/happy-cli`:

```sh
pnpm exec vitest run --project unit src/agy/ src/resume/ src/daemon/run.resume.test.ts src/daemon/sessionEnvironment.test.ts src/agent/acp/AcpSessionManager.test.ts src/api/apiMachine.test.ts src/api/apiMachine.resumeFallback.test.ts
pnpm run typecheck
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-acp.mts
pnpm exec tsx --tsconfig tsconfig.json scripts/verify-agy-title.mts
```

The unit/wire suites include shared mapper regressions,
slow-chunk Markdown integrity, safe tool failure/interruption status, permission allow/deny/pending-abort, explicit session
loading and replay suppression, model/mode requests, unsupported inputs,
control timeouts, spawn failure, disconnect recovery without prompt replay,
cooperative/uncooperative cancellation, forced process cleanup, image ownership,
FIFO settings and offline reconnection.

The authenticated live probe, run for #38, uses a temporary fixture workspace and real `agy`
credentials already installed on the host. The updated probe verifies tool cards before completion,
Read/Bash cards, multi-turn context, explicit resume after process restart,
model switching, red-image interpretation, cancellation and a successful next
turn. It prints event types/timing only, not credentials, image contents, prompt
responses or arbitrary tool output. It consumes provider requests and is opt-in,
not part of the default unit suite. The observed six-turn run passed in about
42 seconds. This is real ACP/Happy-envelope validation, not a physical-phone UI
test.

The separate title live probe, also run for #38, verifies automatic initial title generation from
an ordinary gardening question, an explicit topic/title change, and title
updates after explicit resume, using real `agy acp` and the real Happy MCP
server/bridge in default permission mode. It records fixture summaries through
a local test client, without connecting to the production Happy API. All three
scenarios passed, and the probe exited normally with no remaining bridge child.
The MCP endpoint test also verifies routing after a Happy client swap.

## App and web resume

The shared session view now offers Resume for disconnected AGY ACP sessions
with `agySessionId` on the same online machine. The daemon must advertise
`resumeSupport.agy: true`; older daemons and explicit print transport do not
enable this button. The normal encrypted machine resume RPC carries the original
Happy ID and its per-session key, and launches `agy --resume <native-ID>`.
The runner reattaches to the original Happy session, preserves saved metadata
(including title/model choices), clears archive state, and skips replaying old
messages. New messages continue the loaded ACP conversation. Model/permission
launch arguments are honored. Native load failures never create a fresh native
conversation. Old print sessions without a saved native ID remain unsupported
and report the missing conversation identifier.

`happy resume <Happy-ID>` also supports persisted AGY sessions. In contrast,
`happy agy --resume <native-ID>` without a Happy reconnect identity still creates
a new Happy chat wrapping the selected native conversation. AGY reconnect
metadata is sent through a session-scoped child environment value which is
removed from unrelated launches; incomplete/mismatched identities fail instead
of silently creating a new Happy session.

App/web validation (from `packages/happy-app`):

```sh
pnpm exec vitest run sources/utils/sessionResume.test.ts sources/utils/resumeCommand.test.ts sources/sync/ops.resume.test.ts
pnpm run typecheck
```

All 21 cases across 3 files pass, as do CLI and app typechecks and the CLI build.
Tests cover shared button eligibility, old-daemon gating, metadata schema
preservation, the encrypted RPC payload, daemon launch/metadata refresh, the
original Happy ID/key/cursors, retained title/settings, and historical-message
suppression. App and web use the same view/action implementation. This is
component-logic/RPC/runner validation with mocked transport boundaries, not a
physical-phone or browser end-to-end test. The real native ACP load/resume path
was verified separately by the authenticated live probes above. No app/web
release, CLI installation or daemon restart is performed by this PR.

## Output regression validation

The app fixture `sources/sync/agyOutput.spec.ts` exercises the shared wire
constructor, app normalization and reducer with synthetic Markdown and both
successful/failed tool completions, including a three-column Markdown table
through the actual app parser. Clock-skew tests verify immediate prompt order,
server echo reconciliation, consecutive sends and history reload. No production conversation is checked in.
`MessageView.test.ts` covers collapsed/expanded AGY thoughts and unchanged
visibility for other agents. Transcript grouping and ChatList integration tests
also cover both grouping settings, live flavor changes, empty wrapped thoughts
and interrupted turns without a final answer. Legacy optimistic prompts are clamped after existing visible messages, then
reconciled once to server time; receipt-driven ordering remains authoritative.
The runner test deliberately pauses between chunks
to reproduce timer fragmentation. Historical live probe results above refer to
#38; reruns of the updated probe are reported separately in the PR.

Carbon review identified an additional transcript-filter blocker in the original
Thinking patch: the grouping layer removed thoughts before MessageView rendered
them. A separate follow-up opts AGY into that layer, retains default filtering
for other agents, and excludes thoughts when identifying the final answer. Revert
this follow-up before the original Thinking commit. Review follow-ups and test/
documentation commits must be removed first when dropping the full output stack.
