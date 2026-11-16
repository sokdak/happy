# AGY Stop hook validation — 2026-11-16

Environment: Ubuntu 24.04 ARM64, AGY ACP Server 1.5.9, Node 24.16.0.
Implementation base: `1aa6f55` on `sokdak/happy` main. All authenticated runs
used new temporary fixture workspaces/native sessions; production Happy
sessions, user hooks and daemon environments were not changed.

## Automated checks

- CLI typecheck and build passed.
- 208 tests passed across 17 files: AGY, shared ACP message mapping, resume
  lookup and daemon environment handling.
- Includes malformed hook inputs, native error/cancel/budget reasons, repeated
  hook execution, continuation/no-progress/time limits, stale socket epochs,
  sibling isolation, missing controller, version gate, cancelled permissions,
  requests arriving during cancellation, missing hook and denial reporting.

## Authenticated scenarios

| Scenario | Observed outcome |
| --- | --- |
| Single 15-second background command + followup | Final answer delivered; 1 continuation; second turn retained context |
| Two sequential background commands | Both and followup ran exactly once; 2 continuations |
| Two parallel background commands | Both completed before followup; 1 continuation |
| Background command exits 7 | Exit code reported, no retry; 1 continuation |
| Permission rejected | One rejection; no retry, no success status; clear denial error |
| Cancel during background work, then new prompt | Cancel acknowledged promptly; no late backend messages; exact native ID reloaded and next answer delivered |
| Cancel just after Stop returned continue | No old followup or late messages; fresh controller reloaded the same session and answered the next prompt |
| Simulated long-running watcher | 4 continuations then explicit unconfirmed completion; no success status |
| Existing project Stop hook | Existing hook and compatibility hook both executed |
| Hook command fails (`exit 1`) | Explicit missing-hook/unconfirmed error; no false success |
| Project disables same named hook | Existing setting preserved; explicit unconfirmed error |
| Existing ACP regression script with flag enabled | Streaming, tools, context, resume, model switch, image, cancel, recovery passed |
| Existing Happy title MCP regression with flag enabled | Initial title, topic change and resumed-conversation title passed |

The failure fixture revealed that AGY reports a shell tool as ACP `completed`
even when the command exits 7; the model correctly reports the exit code.
These tests assert command outcome reporting and no retry, not an invented
ACP `failed` status. The initial watcher fixture also attempted unrelated
hook investigation; the strengthened continuation instruction forbids that,
while actual bounds and permission decisions remain enforced by code.

Cancellation does **not** prove native OS command termination. These fixtures
use self-terminating sleeps, no network listeners or persistent writes. The
product reports unresolved completion and does not kill guessed process IDs.
Intentional daemons remain a documented limitation of this opt-in experiment.

Raw JSON and console evidence for this run is retained locally under
`/tmp/happy-agy-stop-hook-validation`, with `validation-summary.json` recording
the SHA-256 hashes of the 13 successful live artifacts. This temporary path is
not a permanent CI artifact; the checked-in verification scripts reproduce
the scenarios. No credentials or native transcript contents are committed.

## Revert boundaries

- `238e2c4`: completion reporting, independent of the workaround.
- `1074056`: optional hook and AGY backend integration. Disable first with
  `HAPPY_AGY_STOP_HOOK=0`; revert this commit when the native ACP issue is fixed.
- A separate verification commit contains the live probe and this report.

Default remains off. This validation is for the explicitly enabled 1.5.9
compatibility path; it does not certify arbitrary AGY versions, third-party
hook behavior or universal background-process cancellation.

## Independent Carbon review

Actual `gemini-4-carbon-high` reviewed the implementation and then the follow-up
fixes in native conversation `57f7c334-dad3-4936-9cb8-22be6deca369`.
Both completed reviews returned `SUCCESS`, a nonempty response and no denied
actions. An earlier time-limited attempt returned no final response and was
not treated as approval.

Final delta verdict: **“No blockers or regressions introduced”** for the
**off-by-default AGY 1.5.9 opt-in PR only**. The review does not approve enabling
this by default in production. Its pending verification conditions were then
satisfied: the expanded 208-test suite passed, and actual cancel-after-hook
and permission-denial scenarios passed again after the changes.

All four actionable findings were addressed: drain cancellation independently
of delayed process exit; accept larger native hook input while forwarding only
six fields; distinguish graceful denial from skipped Stop; invalidate truncated
hook communications and handle server errors. Regression tests cover each.
The independent reviewer inspected code and supplied evidence; the executor
ran the tests and authenticated probes.

Final review responses are retained locally as `carbon-review-final.json` and
`carbon-delta.json` in the evidence directory. The remaining process-cleanup,
intentional-daemon and untested-platform limitations above remain explicit.
