# Native AGY tool labels

AGY 1.5.9 sends `manage_task` and `schedule` as ACP `kind: "other"`,
with titles `Run manage_task` and `Run schedule`. It supplies the native
arguments directly in `rawInput` and omits `rawInput.name`. Treating the broad
ACP kind as the tool name therefore discarded both the operation and its input.

The AGY adapter recognizes exact `Run <id>` labels from a fixed native-tool
allowlist only when the ACP kind is `other` or absent. A title cannot override
an explicit execution/edit category. Explicit `rawInput.name` still takes precedence. Arbitrary human
titles and MCP names are not inferred through this list. The configured Happy
title tool keeps its separate exact-match handling.

Examples use the existing tool cards without an app/server schema change:

- `manage_task status task-42`
- `schedule 10s for task-42`

Scheduled prompt text and arbitrary condition expressions are not forwarded.
Permission requests still go through the existing handler, including denials.

Task/status/scheduling tools share the Bash display card with real commands.
The Stop hook must therefore count native `run_command` completions rather
than the display name when resetting its no-progress allowance. This safeguard
is a separate commit and can remain when reverting the label mapping. The
4-stalled/12-total continuation limits and cancellation behavior remain intact.

`Model produced invalid output.` is a separate provider warning. In the
investigated native transcript the model returned neither response text nor
tool calls. AGY then resumed tool work and completed the turn. This patch
neither hides that warning nor injects a retry prompt or claims to repair the
model response.

Authenticated AGY 1.5.9 / `gemini-4-carbon-high` fixtures reproduced two `other`
cards before the fix and the named task/schedule cards afterwards, with one
execution of the harmless command and complete tool lifecycles. Regression
tests cover task-polling continuation bounds, real command progress, native
label recognition, unknown-title rejection, scheduling redaction and denial.

The change affects newly generated messages from the updated CLI. Historical
encrypted messages already stored as `other` retain their original contents.
No historical session rewrite or running-session restart is included.
