# Message Pipeline and Render Cost Design

## Goal

Remove the per-message work in the sync store that grows with session length, and stop collapsed tool/work group cells from re-rendering on every streamed token. This is the follow-up to `2026-08-07-web-scroll-responsiveness-design.md`, which fixed the two contributors that grow with elapsed usage; this one addresses the two that grow within a single long session.

## Scope

- **Fix C** — replace the full map clone and full re-sort in the store with an incremental merge.
- **Fix D** — make `onToggle` a stable reference so group cells can be memoized.
- **Fix E** — reuse group object identity across regroupings when nothing in the group changed.

Deferred: incremental grouping. `groupMessagesForDisplay` still walks all messages on every change. It is the smaller half of the measured cost and by far the riskiest to make incremental, since it would put grouping correctness at stake.

## Measurements

Taken by bundling the real modules and running them in Node with no React involved. Per incoming message, by session size:

| messages | grouping | map clone | `Object.values` + sort | incremental insert |
|---|---|---|---|---|
| 500 | 0.095 ms | 0.153 ms | 0.047 ms | 0.001 ms |
| 2000 | 0.233 ms | 0.332 ms | 0.214 ms | 0.004 ms |
| 8000 | 1.141 ms | 1.630 ms | 1.203 ms | 0.015 ms |

Two things follow. The map clone is the single largest item — larger than the sort — so fixing only the sort would leave most of the cost in place. And incremental insertion is roughly two orders of magnitude cheaper than either, because copying an 8000-element array is cheap while spreading an 8000-key object is not.

## Root Cause

**The store rebuilds the whole message collection on every incoming message.** `sources/sync/storage.ts:698-705` shallow-copies `messagesMap` and re-sorts every message, on each socket message.

The same pattern appears a second time at `sources/sync/storage.ts:569-575`, inside `applySessions` — and there it sits inside a `sessions.forEach` loop, so a sessions refresh carrying agentState changes costs O(sessions × messages). Both sites need the same treatment.

**Group cells can never be memoized.** `ToolGroupView` and `AgentWorkGroupView` are both `React.memo`, but two things defeat it on every render: `groupMessagesForDisplay` allocates fresh group objects on each call, and all three call sites pass an inline closure (`ChatList.tsx:319`, `ChatList.tsx:330`, `ToolGroupView.tsx:180`).

Note what is *not* broken: `MessageView` memoization already works. The reducer mutates its internal state in place but emits freshly-constructed `Message` objects through `convertReducerMessageToMessage` (`sources/sync/reducer/reducer.ts:1133`), and only for changed ids. Unchanged messages keep their previous object identity, so plain message cells already skip re-rendering correctly. The defect is confined to group cells.

## Architecture

### Fix C — incremental message merge

A new pure module, `sources/sync/messageList.ts`:

```ts
export function mergeMessagesInto(
    current: Message[],
    lookup: Map<string, Message>,
    incoming: Message[],
): Message[];
```

`current` is newest-first, descending by `createdAt`. `lookup` is mutated in place. The return is a new array, or `current` unchanged when `incoming` is empty.

For each incoming message:

- **Already present** — replace it at its existing index. The reducer preserves `createdAt` on updates (it sets `state`, `result`, and `completedAt`, never `createdAt`), so an update cannot change sort position.
- **New** — binary-search the insertion point and splice it in.

Ordering of equal `createdAt` values is preserved exactly. Today's behavior comes from a stable sort over `Object.values`, which means insertion order wins among ties. The incremental path reproduces this by inserting *after* every entry whose `createdAt` is greater than or equal to the incoming one.

Two guards:

- **Bulk fallback.** Older-page loads arrive in batches of about a hundred. When `incoming.length > 8`, concatenate and sort once instead of performing many splices. Eight is chosen because each splice costs O(current) while one sort costs O(current log current), so splicing wins only while the batch is smaller than log2(current) — about 11 at 2000 messages and 13 at 8000. Eight sits safely below that for any realistic session, keeping streaming (one or two messages at a time) on the incremental path and sending page loads to the sort.
- **Ordering safety net.** If an incoming message's `createdAt` differs from that of the entry it replaces, fall back to a full re-sort. The invariant this fix relies on then cannot silently break if the reducer changes later.

The array stays immutable, because copying it is cheap. The lookup map is mutated in place, because cloning it is not — it is the largest single cost measured. `messagesMap` changes type from `Record<string, Message>` to `Map<string, Message>` so that the mutation is visible in the type rather than looking like an accidentally-mutated plain object, and so lookups and writes are O(1).

Mutating store state is a deliberate exception here, and it has precedent in this same file: `storage.ts:578` already carries `reducerState` through with the comment "The reducer modifies state in-place, so this has the updates". The exception is safe because `messagesMap` has only lookup consumers — `storage.ts:409`, `storage.ts:1433` (`useMessage`), and `sync.ts:2821` — and because change detection does not depend on the map's identity: the reducer supplies new `Message` objects for changed ids, so `useMessage`'s `useShallow` comparison still sees a changed value. The wrapper `SessionMessages` object and the `messages` array are still replaced, so zustand still publishes a new state root.

Nine locations reference `messagesMap` and move to the `Map` API: seven in `sources/sync/storage.ts` (the type at 64, the read at 409, the merge at 569-579, the initializer at 673, the merge at 698-737, the `applyMessagesLoaded` build at 761-796, and `useMessage` at 1433), one in `sources/sync/sync.ts:2821`, and one in `sources/hooks/useDemoMessages.ts`.

### Fix D — stable toggle callback

`onToggle` changes from `() => void` to `(groupId: string) => void` on both `ToolGroupViewProps` and `AgentWorkGroupViewProps`, and each component calls `onToggle(group.id)` itself.

All three call sites then pass an existing handler directly instead of wrapping it. Both handlers are already `React.useCallback((groupId: string) => {...}, [])` — `handleToggleGroup` in `ChatList.tsx` and `handleToggleNestedGroup` at `ToolGroupView.tsx:157` — so they are stable without further change.

### Fix E — group identity reuse

A new pure function in `sources/hooks/displayItemReconcile.ts`:

```ts
export function reconcileDisplayItems(
    prev: DisplayItem[],
    next: DisplayItem[],
): DisplayItem[];
```

For each item in `next`, if `prev` holds an item with the same `id` and `type` whose contents are equivalent, the previous object is substituted so downstream `React.memo` sees an unchanged prop.

Equivalence is defined field by field, so a future field addition cannot silently be ignored:

- `messages` — same length, and every element the same object reference
- `hasRunning` and `hasPendingPermission` — strictly equal
- for `agent-work-group` only, `startedAt` and `completedAt` — strictly equal, since `AgentWorkGroupView` renders elapsed time from them

Reference identity is the right test for members precisely because the reducer produces new `Message` objects for changed messages and preserves identity for unchanged ones.

`useGroupedMessages` holds the previous result in a ref and applies this pass to each newly computed array. `groupMessagesForDisplay` stays pure and unmodified, so its existing test suite continues to cover it directly.

## Deliberately Unchanged

`renderItem` in `ChatList.tsx` lists `collapsedGroups` in its dependencies, so expanding or collapsing a group still re-renders every mounted cell. This is left alone. During streaming `collapsedGroups` does not change, so Fixes D and E cover the path that actually matters; toggling is an infrequent, user-initiated action. Fixing it would mean routing collapse state around React's normal data flow for no measured benefit.

## Error Handling

The merge helper's ordering safety net is the main one: an unexpected `createdAt` change degrades to a full re-sort rather than producing a misordered list. An empty `incoming` returns `current` by reference, so no state churn is published.

`reconcileDisplayItems` is purely an identity optimization. If it fails to match anything it returns `next` unchanged, which is exactly today's behavior — a miss costs a re-render, never a wrong render.

## Testing

`sources/sync/messageList.spec.ts`:

- inserting a newer message places it at the head
- inserting into the middle lands at the right index
- inserting an older message places it at the tail
- an existing id is replaced in place, leaving length and order unchanged
- messages with equal `createdAt` keep insertion order, matching the previous stable sort
- a bulk batch produces exactly the same array as a full concatenate-and-sort
- an incoming message whose `createdAt` differs from the entry it replaces triggers a full re-sort and still yields correct order
- empty `incoming` returns the same array reference

`sources/hooks/displayItemReconcile.spec.ts`:

- an unchanged group keeps its previous object identity
- a group whose member message identity changed gets a new object
- a group whose `hasRunning` or `hasPendingPermission` flag changed gets a new object
- newly appearing groups pass through
- removed groups do not reappear
- plain message items are unaffected

Existing suites that must keep passing untouched: `sources/hooks/useGroupedMessages.test.ts` and the full 795-test suite. Ordering is user-visible, so a regression there is the outcome these tests exist to prevent.

## Verification

`pnpm typecheck` and the full vitest suite. Then re-run the standalone benchmark from the investigation to confirm the per-incoming-message cost at 2000 and 8000 messages drops to roughly the incremental-insert numbers above.

Runtime browser measurement is still outstanding from the previous spec's Task 4 and is not superseded by this work. No claim that the app feels faster should be made without it.
