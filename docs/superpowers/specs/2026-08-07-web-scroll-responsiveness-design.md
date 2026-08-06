# Web Scroll Responsiveness Design

## Goal

Stop the web app from degrading the longer a session of use lasts. Users report that after extended use, scrolling in a chat becomes laggy and the whole UI turns unresponsive. This design addresses the two causes that grow without bound: the navigation stack never releases visited session screens, and the chat list mounts far more content than it needs to.

## Scope

Two changes:

- **Fix A** — bound the navigation stack so switching sessions does not accumulate mounted session screens.
- **Fix B** — tune `FlatList` virtualization on the chat message list.

Both are confined to `packages/happy-app`. No protocol, server, or CLI changes.

## Root Cause Findings

Investigation identified four independent contributors. This design fixes the first two.

**1. The navigation stack grows without bound.** `navigateToSession` in `sources/hooks/useNavigateToSession.ts:12` always calls `router.push`. There is no `replace` path. The app also never enables screen freezing: `freezeOnBlur`, `enableFreeze()`, and `detachInactiveScreens` appear nowhere in the codebase, even though `react-native-screens` 4.22 is a dependency. Every session the user opens therefore leaves a fully mounted `SessionView` — including its `ChatList` and its live store subscriptions — in the tree for the lifetime of the tab. This is the only contributor that grows purely with elapsed usage, which makes it the best match for the reported symptom.

**2. The chat list has no virtualization tuning.** The `FlatList` at `sources/components/ChatList.tsx:421` sets none of `windowSize`, `maxToRenderPerBatch`, or `initialNumToRender`, so it inherits the React Native defaults — notably `windowSize: 21`, meaning roughly twenty-one viewport-heights of cells stay mounted. By contrast `sources/components/SessionsList.tsx:404-406` deliberately sets `windowSize={5} maxToRenderPerBatch={8} initialNumToRender={12}` on a far lighter list of plain rows. The heaviest surface in the app is the one left untuned, and its cost is multiplied by every screen retained under finding 1.

**3. Deferred — the message pipeline is re-run in full on every incoming message.** `sources/sync/storage.ts:698-705` shallow-copies the entire `messagesMap` and re-sorts every message on each socket message, then `sources/hooks/useGroupedMessages.ts:63-85` walks all messages three more times. Measured by bundling the real grouping module and running it in Node with no React involved:

| messages in session | grouping | merge + sort | total per incoming message |
|---|---|---|---|
| 500 | 0.095 ms | 0.166 ms | 0.261 ms |
| 2000 | 0.233 ms | 0.522 ms | 0.755 ms |
| 8000 | 1.141 ms | 2.798 ms | 3.938 ms |

The cost grows with session length and is paid once per message. In the browser, React reconciliation is layered on top. This is real but is deferred: it degrades within a single long session rather than with elapsed usage, and fixing it means restructuring the reducer.

**4. Deferred — group cells can never be memoized.** `groupMessagesForDisplay` allocates fresh `tool-group` and `agent-work-group` objects on every call, and `ChatList.tsx:319,330` passes `onToggle={() => handleToggleGroup(item.id)}`, a new closure each render. The `React.memo` on `ToolGroupView` and `AgentWorkGroupView` is therefore always defeated.

## Architecture

### Fix A — bound the navigation stack

Introduce a pure decision function in a new module, `sources/hooks/sessionNavigation.ts`. It is a separate file with no imports at all, so its test needs no mocking of `expo-router`, the store, or analytics — the same separation `sources/utils/newSessionSidebarLayout.ts` uses for layout gating.

```ts
export type SessionNavigationMode = 'push' | 'replace' | 'noop';

export function resolveSessionNavigation(
    currentPathname: string,
    targetSessionId: string,
): SessionNavigationMode;
```

Rules, in order:

1. If the current pathname does not begin with `/session/`, return `push`.
2. If the pathname's first segment after `/session/` is a static child route rather than a session id, return `push`. `recent` (`app/(app)/session/recent.tsx`) is the only such route, and it is a browse surface — pushing from it keeps the recent list reachable via back, exactly as it is today.
3. If the current pathname is exactly the target session's own chat screen (`/session/{target}` with no sub-route), return `noop`. This keeps re-selecting the already-open session from performing a pointless `replace`.
4. Otherwise return `replace`.

Rule 2 exists because `/session/recent` and `/session/{id}` have the same shape. Without it, opening a session from the recent list would replace the list instead of pushing over it, silently changing that screen's back behavior — a regression unrelated to the goal.

Session ids are percent-encoded in the route. The comparison in rule 1 decodes the pathname segment before comparing it to `targetSessionId`, so a session id containing reserved characters does not produce a false `push`.

Rule 2 intentionally covers one more case worth stating plainly: selecting session A while sitting on one of A's own sub-routes, such as `/session/A/info`. That yields `replace`, landing the user on A's chat — which is what tapping the session should do — at the cost of a stack of `[home, session A, session A]`, where the lower entry is the earlier mount. It is a duplicate, and it is accepted: the depth is still bounded at three, and the alternative of returning `noop` would leave the user stranded on the info screen after tapping the session.

The function is pure and takes the pathname as an argument, so it is unit-testable without rendering an Expo screen — the same approach `sources/utils/newSessionSidebarLayout.ts` takes for layout gating.

Wiring:

- `useNavigateToSession()` reads `usePathname()` internally and passes it through. This is the pattern `SessionsList.tsx:232` already uses to derive `selectedSessionId`.
- The standalone `navigateToSession(router, sessionId, currentPathname)` gains an explicit `currentPathname` parameter rather than reaching for router internals. Its only caller, `sources/app/_layout.tsx:321`, is already inside a component's `useCallback` and can supply `usePathname()`.

That call site needs one specific precaution. The enclosing `handleNotificationResponse` callback is declared with a `[router]` dependency list and is itself a dependency of the effect at `_layout.tsx:331-356`, which registers a notification listener and reads the last notification response. Adding `pathname` to the callback's dependencies would tear down and re-register that listener on every navigation. The pathname is therefore held in a ref that is updated on each render and read inside the callback, leaving the dependency list unchanged.

`trackSessionSwitched` continues to fire for `push` and `replace`. It is skipped for `noop`, because no switch occurs.

Resulting stack depth:

| Navigating from | Resulting stack | Depth |
|---|---|---|
| home | `[home, session B]` | 2 |
| `/session/A` | `[home, session B]` | 2 |
| `/session/A/info` | `[home, session A, session B]` | 3 |

The sub-route case is a deliberate, accepted limitation. When the user is on `/session/A/info` (or `/files`, `/file`, `/message/[messageId]`) a `replace` swaps only that sub-route, leaving session A's screen beneath it. Depth reaches three and then stays there, because every later switch again replaces only the top entry. Unbounded growth — the actual defect — is eliminated. Reducing the worst case to two would require `router.dismissTo` or `navigation.reset`, whose availability in this Expo version could not be confirmed while the workspace has no installed dependencies, so it is out of scope here.

Drafts survive the newly-introduced unmount. `sources/hooks/useDraft.ts` persists drafts into the store keyed by session id and has a save-on-unmount effect at lines 99-105, so text typed and not yet debounce-saved is still flushed when `replace` tears the screen down.

### Fix B — chat list virtualization

Add three props to the `FlatList` at `sources/components/ChatList.tsx:421`:

```
windowSize={10}
maxToRenderPerBatch={5}
initialNumToRender={15}
```

`windowSize={10}` roughly halves mounted content versus the default 21. These are starting values, to be confirmed or tightened against the browser measurements described below rather than chosen by feel.

Two props are deliberately excluded. `removeClippedSubviews` has known breakage on inverted lists and on React Native Web. `getItemLayout` cannot be supplied because cell heights are markdown-driven and variable.

The residual risk follows from that same variability: an inverted, variable-height list with no `getItemLayout` can show blank regions during fast scrolling if the render window is too small. Conservative values are chosen specifically to keep that risk low, and the measurement step exists to decide whether tightening further is justified.

## Behavior Changes

Back navigation from a session screen now returns to home rather than to the previously viewed session. This is the intended trade-off: the sidebar already presents sessions as a selectable list with the active one highlighted, so a breadcrumb of previously visited sessions is not the natural model. On web this also applies to the browser's back button.

Opening a session from a push notification or deep link while already viewing another session now replaces rather than stacks, which makes deep-link entry consistent with in-app switching.

## Non-Goals

Findings 3 and 4 are not addressed. Neither is eviction of `sessionMessages`, which currently retains every visited session's messages until the session is deleted. The `console.log` calls on the socket update path in `sources/sync/sync.ts` are left alone; they retain objects only while DevTools is open and are a secondary concern.

## Error Handling

`resolveSessionNavigation` returns `push` for any pathname it does not recognise, including malformed input. `push` is today's unconditional behavior, so the fallback can never be worse than the current state.

If pathname decoding throws on malformed percent-encoding, the raw segment is compared instead. The consequence of a mismatch is at worst a redundant `replace`, never a lost navigation.

## Testing

Unit tests, in `sources/hooks/sessionNavigation.spec.ts`, run under the existing vitest setup (`include: ['sources/**/*.{spec,test}.ts']`):

- home pathname yields `push`
- `/session/recent` yields `push`, not `replace`
- a different session's pathname yields `replace`
- the target session's own chat pathname yields `noop`
- a different session's sub-route (`/session/A/info`, target B) yields `replace`
- the target's own sub-route (`/session/A/info`, target A) yields `replace`, not `noop`
- a percent-encoded session id matching the target yields `noop`
- a malformed percent-encoded pathname does not throw and yields `replace`
- an unrecognised or empty pathname yields `push`

The wiring is additionally guarded by the existing `hooks/useStartSessionFromDraft.test.ts`, which mocks `useNavigateToSession` and asserts it is called with a single session id. The hook's returned signature is unchanged, so that suite must keep passing untouched.

Written before the implementation, per test-driven-development.

## Verification

Beyond the unit tests:

1. `pnpm typecheck` and the existing test suite in `packages/happy-app`.
2. Browser before/after, which requires `pnpm install` in the workspace and a running web build:
   - **Stack growth** — switch between ten sessions, then count mounted session screens and total DOM nodes via `document.querySelectorAll('*').length`. Expect a flat count after the fix instead of one growing per switch.
   - **Scroll cost** — scroll a long chat while recording long tasks and frame timings. Compare against the same trace on `origin/main`.

The measured numbers decide whether Fix B's values stay conservative or are tightened toward `windowSize={5}`. Claims about improvement will cite those traces; no success is reported without them.
