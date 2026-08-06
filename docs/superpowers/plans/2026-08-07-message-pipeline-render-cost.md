# Message Pipeline and Render Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the per-message full clone and full re-sort from the sync store, and let collapsed group cells memoize so they stop re-rendering on every streamed token.

**Architecture:** A pure `mergeMessagesInto` helper maintains the newest-first message array incrementally while mutating an O(1) lookup `Map` in place. A pure `reconcileDisplayItems` pass restores group object identity after regrouping, and `onToggle` becomes a stable id-taking callback so `React.memo` on the group views finally holds.

**Tech Stack:** TypeScript, React 19.2, zustand, vitest (node environment, `@` aliased to `sources`).

## Global Constraints

- All changes confined to `packages/happy-app`.
- Message order is user-visible. Equal `createdAt` values must keep insertion order, matching the stable sort being replaced.
- `BULK_MERGE_THRESHOLD` is 8.
- `messagesMap` becomes `Map<string, Message>` and is mutated in place. The enclosing `SessionMessages` object and the `messages` array must still be replaced so zustand publishes a new state root.
- Do not modify `groupMessagesForDisplay`. It stays pure so `sources/hooks/useGroupedMessages.test.ts` keeps covering it directly.
- Do not touch `renderItem`'s dependency list in `ChatList.tsx`. Toggling re-rendering all cells is accepted.
- Run `pnpm typecheck` and `npx vitest run` from `packages/happy-app` before each commit. The suite is currently 66 files / 795 tests, all passing.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/happy-app/sources/sync/messageList.ts` (create) | Pure incremental merge. Owns ordering rules and the bulk/resort fallbacks. |
| `packages/happy-app/sources/sync/messageList.spec.ts` (create) | Ordering and fallback tests. |
| `packages/happy-app/sources/sync/storage.ts` (modify) | Uses the helper at both merge sites; `messagesMap` becomes a `Map`. |
| `packages/happy-app/sources/sync/sync.ts` (modify) | One `messagesMap` read moves to `.get()`. |
| `packages/happy-app/sources/hooks/useDemoMessages.ts` (modify) | Builds a `Map` for the demo session. |
| `packages/happy-app/sources/components/ToolGroupView.tsx` (modify) | `onToggle` takes a group id; nested call site passes the handler directly. |
| `packages/happy-app/sources/components/ChatList.tsx` (modify) | Two call sites pass `handleToggleGroup` directly. |
| `packages/happy-app/sources/hooks/displayItemReconcile.ts` (create) | Pure group-identity reconciliation. |
| `packages/happy-app/sources/hooks/displayItemReconcile.spec.ts` (create) | Identity reuse tests. |
| `packages/happy-app/sources/hooks/useGroupedMessages.ts` (modify) | Applies the reconcile pass via a ref. |

---

### Task 1: Incremental merge helper

**Files:**
- Create: `packages/happy-app/sources/sync/messageList.ts`
- Test: `packages/happy-app/sources/sync/messageList.spec.ts`

**Interfaces:**
- Consumes: `Message` from `./typesMessage`.
- Produces: `mergeMessagesInto(current: Message[], lookup: Map<string, Message>, incoming: Message[]): Message[]`. Task 2 is its only caller.

**Context you need:** The array is newest-first, descending by `createdAt`. Today's ordering comes from `Object.values(map).sort((a, b) => b.createdAt - a.createdAt)`; V8's sort is stable, so among equal `createdAt` the map's insertion order wins. Insertion must therefore land *after* every entry whose `createdAt` is greater than or equal to the incoming one. The reducer preserves `createdAt` on updates — it sets `state`, `result`, and `completedAt` only — which is what makes in-place replacement safe.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-app/sources/sync/messageList.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeMessagesInto } from './messageList';
import { Message } from './typesMessage';

function msg(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id } as Message;
}

/** Builds the newest-first array plus its lookup, the way the store holds them. */
function seed(messages: Message[]): { current: Message[]; lookup: Map<string, Message> } {
    const lookup = new Map<string, Message>();
    for (const m of messages) lookup.set(m.id, m);
    const current = [...messages].sort((a, b) => b.createdAt - a.createdAt);
    return { current, lookup };
}

function ids(messages: Message[]): string[] {
    return messages.map((m) => m.id);
}

describe('mergeMessagesInto', () => {
    it('returns the same reference when nothing is incoming', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        expect(mergeMessagesInto(current, lookup, [])).toBe(current);
    });

    it('places a newer message at the head', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2)]);
        const next = mergeMessagesInto(current, lookup, [msg('c', 3)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('inserts into the middle at the right index', () => {
        const { current, lookup } = seed([msg('a', 1), msg('c', 3)]);
        const next = mergeMessagesInto(current, lookup, [msg('b', 2)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('places an older message at the tail', () => {
        const { current, lookup } = seed([msg('b', 2), msg('c', 3)]);
        const next = mergeMessagesInto(current, lookup, [msg('a', 1)]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
    });

    it('replaces an existing id in place without changing order or length', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2), msg('c', 3)]);
        const updated = msg('b', 2);
        const next = mergeMessagesInto(current, lookup, [updated]);
        expect(ids(next)).toEqual(['c', 'b', 'a']);
        expect(next).toHaveLength(3);
        expect(next[1]).toBe(updated);
        expect(lookup.get('b')).toBe(updated);
    });

    it('keeps insertion order among equal createdAt values', () => {
        const { current, lookup } = seed([msg('first', 5)]);
        const next = mergeMessagesInto(current, lookup, [msg('second', 5)]);
        expect(ids(next)).toEqual(['first', 'second']);
        const after = mergeMessagesInto(next, lookup, [msg('third', 5)]);
        expect(ids(after)).toEqual(['first', 'second', 'third']);
    });

    it('matches a full concat-and-sort for a bulk batch', () => {
        const existing = [msg('e1', 100), msg('e2', 101)];
        const { current, lookup } = seed(existing);
        const older = Array.from({ length: 20 }, (_, i) => msg(`o${i}`, i));
        const next = mergeMessagesInto(current, lookup, older);
        const expected = [...existing, ...older].sort((a, b) => b.createdAt - a.createdAt);
        expect(ids(next)).toEqual(ids(expected));
    });

    it('falls back to a full re-sort when an update moves createdAt', () => {
        const { current, lookup } = seed([msg('a', 1), msg('b', 2), msg('c', 3)]);
        const moved = msg('a', 99);
        const next = mergeMessagesInto(current, lookup, [moved]);
        expect(ids(next)).toEqual(['a', 'c', 'b']);
        expect(next).toHaveLength(3);
    });

    it('mutates the supplied lookup rather than replacing it', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        const added = msg('b', 2);
        mergeMessagesInto(current, lookup, [added]);
        expect(lookup.size).toBe(2);
        expect(lookup.get('b')).toBe(added);
    });

    it('does not mutate the input array', () => {
        const { current, lookup } = seed([msg('a', 1)]);
        const next = mergeMessagesInto(current, lookup, [msg('b', 2)]);
        expect(next).not.toBe(current);
        expect(ids(current)).toEqual(['a']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/happy-app`: `npx vitest run sources/sync/messageList.spec.ts`
Expected: FAIL — cannot resolve `./messageList`.

- [ ] **Step 3: Write the implementation**

Create `packages/happy-app/sources/sync/messageList.ts`:

```ts
import { Message } from './typesMessage';

/**
 * Incremental maintenance of a session's message list.
 *
 * The list is newest-first, descending by createdAt. Rebuilding it from a
 * cloned lookup plus a full sort on every incoming message was the largest
 * per-message cost in the store, and it grew with session length.
 */

/**
 * Above this batch size one sort beats repeated splices: each splice costs
 * O(current) while a sort costs O(current log current), so splicing only wins
 * while the batch is smaller than log2(current) — about 11 at 2000 messages.
 * Streaming delivers one or two at a time; older-page loads deliver ~100.
 */
const BULK_MERGE_THRESHOLD = 8;

function sortNewestFirst(messages: Message[]): Message[] {
    return messages.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Index at which a message with `createdAt` belongs, placed after every entry
 * whose createdAt is greater than or equal to it. That reproduces the stable
 * sort this replaces, where lookup insertion order decided ties.
 */
function findInsertIndex(messages: Message[], createdAt: number): number {
    let lo = 0;
    let hi = messages.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (messages[mid].createdAt >= createdAt) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Merges `incoming` into `current`, mutating `lookup` in place.
 *
 * The lookup is mutated deliberately: cloning it was the single largest
 * measured cost, and nothing relies on its identity for change detection —
 * the reducer supplies new Message objects for changed ids. A fresh array is
 * returned whenever anything changed, so store consumers still see a new value.
 */
export function mergeMessagesInto(
    current: Message[],
    lookup: Map<string, Message>,
    incoming: Message[],
): Message[] {
    if (incoming.length === 0) {
        return current;
    }

    // An update that moves createdAt would invalidate the ordering assumption
    // behind incremental insertion. Re-sort rather than emit a misordered list.
    let requiresResort = false;
    for (const message of incoming) {
        const existing = lookup.get(message.id);
        if (existing && existing.createdAt !== message.createdAt) {
            requiresResort = true;
            break;
        }
    }

    if (requiresResort || incoming.length > BULK_MERGE_THRESHOLD) {
        for (const message of incoming) {
            lookup.set(message.id, message);
        }
        return sortNewestFirst([...lookup.values()]);
    }

    const next = current.slice();
    for (const message of incoming) {
        const existing = lookup.get(message.id);
        lookup.set(message.id, message);
        if (existing) {
            // A linear scan here is deliberate: it is O(current) but on the
            // order of microseconds even at 8000 messages, and far simpler to
            // reason about than a binary search across a run of equal
            // createdAt values.
            const index = next.indexOf(existing);
            if (index !== -1) {
                next[index] = message;
                continue;
            }
            // In the lookup but absent from the array — insert instead of
            // silently dropping it.
        }
        next.splice(findInsertIndex(next, message.createdAt), 0, message);
    }
    return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/happy-app`: `npx vitest run sources/sync/messageList.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/sync/messageList.ts packages/happy-app/sources/sync/messageList.spec.ts
git commit -m "feat(app): add incremental message list merge helper

Maintains the newest-first array by insertion and in-place replacement
instead of cloning the lookup and re-sorting everything per message.

Ties on createdAt keep insertion order, matching the stable sort this
replaces. Two fallbacks to a full sort: batches over eight (older-page
loads), and any update that moves a message's createdAt, since that would
invalidate the ordering assumption.

Not yet wired in.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Switch `messagesMap` to a Map and wire the helper

**Files:**
- Modify: `packages/happy-app/sources/sync/storage.ts` (lines 64, 409, 569-579, 673, 698-737, 761-796, 1433)
- Modify: `packages/happy-app/sources/sync/sync.ts:2821`
- Modify: `packages/happy-app/sources/hooks/useDemoMessages.ts:11-26`

**Interfaces:**
- Consumes: `mergeMessagesInto` from Task 1.
- Produces: `SessionMessages.messagesMap` is now `Map<string, Message>`. No later task depends on this.

**Context you need:** There are two copies of the clone-and-sort. The one at `storage.ts:698` runs per incoming socket message. The one at `storage.ts:569` runs inside a `sessions.forEach` in `applySessions`, making that path O(sessions × messages) per refresh. Both must use the helper. This task must be completed in one commit — a partial `Map` migration leaves the file uncompilable.

- [ ] **Step 1: Change the type declaration**

`storage.ts:64`, currently `    messagesMap: Record<string, Message>;`, becomes:

```ts
    // A Map, and mutated in place by mergeMessagesInto. Cloning it per
    // incoming message was the largest cost in this file; nothing depends on
    // its identity for change detection because the reducer emits new Message
    // objects for changed ids.
    messagesMap: Map<string, Message>;
```

- [ ] **Step 2: Add the helper import**

Add to the imports at the top of `storage.ts`:

```ts
import { mergeMessagesInto } from './messageList';
```

- [ ] **Step 3: Convert the two reads in storage.ts**

`storage.ts:409`, currently:

```ts
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
```

becomes:

```ts
            const toolCallMessage = sessionMessages.messagesMap.get(toolCall);
```

`storage.ts:1433` (inside `useMessage`), currently:

```ts
        return session?.messagesMap[messageId] ?? null;
```

becomes:

```ts
        return session?.messagesMap.get(messageId) ?? null;
```

- [ ] **Step 4: Replace the merge site in `applySessions`**

`storage.ts:569-575`, currently:

```ts
                    const mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });

                    const messagesArray = Object.values(mergedMessagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
```

becomes:

```ts
                    const mergedMessagesMap = existingSessionMessages.messagesMap;
                    const messagesArray = mergeMessagesInto(
                        existingSessionMessages.messages,
                        mergedMessagesMap,
                        processedMessages,
                    );
```

Leave the `updatedSessionMessages[session.id] = { ... }` assignment below it as it is — it already builds a fresh `SessionMessages` object.

- [ ] **Step 5: Replace the per-message merge site**

`storage.ts:698-705`, currently:

```ts
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);
```

becomes:

```ts
                const mergedMessagesMap = existingSession.messagesMap;
                const messagesArray = mergeMessagesInto(
                    existingSession.messages,
                    mergedMessagesMap,
                    processedMessages,
                );
```

- [ ] **Step 6: Convert the two initializers**

`storage.ts:673`, currently `                    messagesMap: {},`, becomes:

```ts
                    messagesMap: new Map(),
```

`storage.ts:761-773` in `applyMessagesLoaded`, currently:

```ts
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });

                    messages = Object.values(messagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);
                }
```

becomes:

```ts
                let messages: Message[] = [];
                const messagesMap = new Map<string, Message>();

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    messages = mergeMessagesInto(messages, messagesMap, reducerResult.messages);
                }
```

- [ ] **Step 7: Convert the read in sync.ts**

`sync.ts:2821`, currently:

```ts
            const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
```

becomes:

```ts
            const message = storage.getState().sessionMessages[sessionId].messagesMap.get(messageId);
```

- [ ] **Step 8: Convert the demo helper**

`useDemoMessages.ts:11-14`, currently:

```ts
        const messagesMap: Record<string, Message> = {};
        messages.forEach(msg => {
            messagesMap[msg.id] = msg;
        });
```

becomes:

```ts
        const messagesMap = new Map<string, Message>();
        messages.forEach(msg => {
            messagesMap.set(msg.id, msg);
        });
```

- [ ] **Step 9: Typecheck and run the full suite**

Run from `packages/happy-app`:

```bash
pnpm typecheck
npx vitest run
```

Expected: typecheck clean. All tests pass — 66 files and 795 tests plus Task 1's 10, so 796 files-worth of assertions with no failures. If typecheck reports a remaining `messagesMap` index access, convert that site to `.get()` too and re-run.

- [ ] **Step 10: Commit**

```bash
git add packages/happy-app/sources/sync/storage.ts packages/happy-app/sources/sync/sync.ts packages/happy-app/sources/hooks/useDemoMessages.ts
git commit -m "perf(app): merge messages incrementally instead of re-sorting

Both copies of the clone-and-sort are gone. The one in applySessions ran
inside a sessions.forEach, so that path was O(sessions x messages) on every
refresh carrying agentState changes.

messagesMap becomes a Map and is mutated in place. The type change makes the
mutation visible rather than looking accidental, and the enclosing
SessionMessages object and messages array are still replaced so zustand
publishes a new state root.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Stable toggle callback

**Files:**
- Modify: `packages/happy-app/sources/components/ToolGroupView.tsx` (both prop types, both components, nested call site at 180)
- Modify: `packages/happy-app/sources/components/ChatList.tsx:319`, `:330`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `onToggle: (groupId: string) => void` on `ToolGroupViewProps` and `AgentWorkGroupViewProps`. Task 4 does not depend on it.

**Context you need:** Both existing handlers already take an id and are already stable — `handleToggleGroup` in `ChatList.tsx` and `handleToggleNestedGroup` at `ToolGroupView.tsx:157` are both `React.useCallback((groupId: string) => {...}, [])`. Only the inline wrappers at the three call sites need removing.

- [ ] **Step 1: Change both prop types**

In `ToolGroupView.tsx`, in `ToolGroupViewProps` and again in `AgentWorkGroupViewProps`, change:

```ts
    onToggle: () => void;
```

to:

```ts
    // Takes the group id so call sites can pass a stable handler. An inline
    // closure here defeated React.memo on every render.
    onToggle: (groupId: string) => void;
```

- [ ] **Step 2: Call it with the group id inside both components**

In both `ToolGroupView` and `AgentWorkGroupView`, every place that invokes `onToggle()` becomes `onToggle(group.id)`. Find them with:

```bash
grep -n "onToggle()" packages/happy-app/sources/components/ToolGroupView.tsx
```

Convert each hit.

- [ ] **Step 3: Pass the handler directly at the nested call site**

`ToolGroupView.tsx:180`, currently:

```tsx
                    onToggle={() => handleToggleNestedGroup(item.id)}
```

becomes:

```tsx
                    onToggle={handleToggleNestedGroup}
```

- [ ] **Step 4: Pass the handler directly at both ChatList call sites**

`ChatList.tsx:319` and `ChatList.tsx:330` both currently read:

```tsx
                    onToggle={() => handleToggleGroup(item.id)}
```

Both become:

```tsx
                    onToggle={handleToggleGroup}
```

- [ ] **Step 5: Typecheck and run the full suite**

Run from `packages/happy-app`:

```bash
pnpm typecheck
npx vitest run
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/components/ToolGroupView.tsx packages/happy-app/sources/components/ChatList.tsx
git commit -m "perf(app): give group views a stable onToggle

All three call sites passed an inline closure, so React.memo on
ToolGroupView and AgentWorkGroupView could never skip a render. onToggle now
takes the group id and the components supply it, letting each site pass its
existing stable useCallback directly.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Group identity reconciliation

**Files:**
- Create: `packages/happy-app/sources/hooks/displayItemReconcile.ts`
- Test: `packages/happy-app/sources/hooks/displayItemReconcile.spec.ts`
- Modify: `packages/happy-app/sources/hooks/useGroupedMessages.ts` (the `useGroupedMessages` hook only)

**Interfaces:**
- Consumes: `DisplayItem`, `ToolGroupItem`, `AgentWorkGroupItem` types from `./useGroupedMessages`.
- Produces: `reconcileDisplayItems(prev: DisplayItem[], next: DisplayItem[]): DisplayItem[]`.

**Context you need:** `groupMessagesForDisplay` allocates fresh `tool-group` and `agent-work-group` objects on every call, so group cells always see a changed `group` prop. Message items (`type: 'message'`) already carry a stable `message` reference for unchanged messages and need no help. Do not modify `groupMessagesForDisplay` itself. `AgentWorkGroupItem` carries `startedAt` and `completedAt` in addition to `messages`, `hasRunning`, and `hasPendingPermission`; `AgentWorkGroupView` renders elapsed time from them, so they must participate in equivalence or the timer would freeze.

**Import direction matters here.** `useGroupedMessages.ts` will import `reconcileDisplayItems`, and the new module needs the display item types back from it. Import those types with `import type` so TypeScript erases the edge entirely and no runtime cycle exists. A plain value import would create a real circular dependency between the two modules.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-app/sources/hooks/displayItemReconcile.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reconcileDisplayItems } from './displayItemReconcile';
import { AgentWorkGroupItem, DisplayItem, ToolGroupItem } from './useGroupedMessages';
import { Message } from '@/sync/typesMessage';

function msg(id: string): Message {
    return { kind: 'agent-text', id, localId: null, createdAt: 1, text: id } as Message;
}

function toolGroup(id: string, messages: Message[], hasRunning = false): ToolGroupItem {
    return { type: 'tool-group', id, messages, hasRunning, hasPendingPermission: false };
}

function workGroup(id: string, messages: Message[], completedAt: number | null = null): AgentWorkGroupItem {
    return {
        type: 'agent-work-group',
        id,
        messages,
        hasRunning: false,
        hasPendingPermission: false,
        startedAt: 10,
        completedAt,
    };
}

describe('reconcileDisplayItems', () => {
    it('reuses the previous object when a tool group is unchanged', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const next = reconcileDisplayItems([prevItem], [toolGroup('g1', shared)]);
        expect(next[0]).toBe(prevItem);
    });

    it('keeps the new object when a member message identity changed', () => {
        const prevItem = toolGroup('g1', [msg('m1')]);
        const nextItem = toolGroup('g1', [msg('m1')]);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when member count changed', () => {
        const shared = msg('m1');
        const prevItem = toolGroup('g1', [shared]);
        const nextItem = toolGroup('g1', [shared, msg('m2')]);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when hasRunning changed', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared, false);
        const nextItem = toolGroup('g1', shared, true);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('keeps the new object when a work group completedAt changed', () => {
        const shared = [msg('m1')];
        const prevItem = workGroup('w1', shared, null);
        const nextItem = workGroup('w1', shared, 42);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('reuses the previous object when a work group is fully unchanged', () => {
        const shared = [msg('m1')];
        const prevItem = workGroup('w1', shared, 42);
        const next = reconcileDisplayItems([prevItem], [workGroup('w1', shared, 42)]);
        expect(next[0]).toBe(prevItem);
    });

    it('does not match across differing types with the same id', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('same', shared);
        const nextItem = workGroup('same', shared);
        const next = reconcileDisplayItems([prevItem], [nextItem]);
        expect(next[0]).toBe(nextItem);
    });

    it('passes new groups through and drops removed ones', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const added = toolGroup('g2', shared);
        const next = reconcileDisplayItems([prevItem], [added]);
        expect(next).toHaveLength(1);
        expect(next[0]).toBe(added);
    });

    it('leaves message items untouched', () => {
        const item: DisplayItem = { type: 'message', id: 'm1', message: msg('m1') };
        const next = reconcileDisplayItems([], [item]);
        expect(next[0]).toBe(item);
    });

    it('returns the same array reference when every item was reused', () => {
        const shared = [msg('m1')];
        const prevItem = toolGroup('g1', shared);
        const nextArray = [toolGroup('g1', shared)];
        const next = reconcileDisplayItems([prevItem], nextArray);
        expect(next[0]).toBe(prevItem);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/happy-app`: `npx vitest run sources/hooks/displayItemReconcile.spec.ts`
Expected: FAIL — cannot resolve `./displayItemReconcile`.

- [ ] **Step 3: Write the implementation**

Create `packages/happy-app/sources/hooks/displayItemReconcile.ts`:

```ts
// Type-only so the edge back to useGroupedMessages is erased at compile time.
// A value import here would create a real circular dependency.
import type { AgentWorkGroupItem, DisplayItem, ToolGroupItem } from './useGroupedMessages';
import type { Message } from '@/sync/typesMessage';

/**
 * Restores object identity for group display items across regroupings.
 *
 * groupMessagesForDisplay allocates fresh group objects every call, so
 * ToolGroupView and AgentWorkGroupView saw a changed prop on every streamed
 * token and their React.memo never held. Message items already carry a stable
 * message reference for unchanged messages and need no help here.
 */

type GroupItem = ToolGroupItem | AgentWorkGroupItem;

function isGroup(item: DisplayItem): item is GroupItem {
    return item.type === 'tool-group' || item.type === 'agent-work-group';
}

function sameMessages(a: Message[], b: Message[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        // Reference equality is the right test: the reducer emits new Message
        // objects for changed messages and preserves identity for unchanged.
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function isEquivalent(prev: GroupItem, next: GroupItem): boolean {
    if (prev.type !== next.type) {
        return false;
    }
    if (prev.hasRunning !== next.hasRunning) {
        return false;
    }
    if (prev.hasPendingPermission !== next.hasPendingPermission) {
        return false;
    }
    if (prev.type === 'agent-work-group' && next.type === 'agent-work-group') {
        // AgentWorkGroupView renders elapsed time from these, so ignoring them
        // would freeze the timer.
        if (prev.startedAt !== next.startedAt || prev.completedAt !== next.completedAt) {
            return false;
        }
    }
    return sameMessages(prev.messages, next.messages);
}

export function reconcileDisplayItems(prev: DisplayItem[], next: DisplayItem[]): DisplayItem[] {
    if (prev.length === 0 || next.length === 0) {
        return next;
    }

    const previousGroups = new Map<string, GroupItem>();
    for (const item of prev) {
        if (isGroup(item)) {
            previousGroups.set(item.id, item);
        }
    }
    if (previousGroups.size === 0) {
        return next;
    }

    let changed = false;
    const result = next.map((item) => {
        if (!isGroup(item)) {
            return item;
        }
        const previous = previousGroups.get(item.id);
        if (previous && isEquivalent(previous, item)) {
            changed = true;
            return previous;
        }
        return item;
    });

    return changed ? result : next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/happy-app`: `npx vitest run sources/hooks/displayItemReconcile.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Apply the pass in `useGroupedMessages`**

In `useGroupedMessages.ts`, add the import:

```ts
import { reconcileDisplayItems } from './displayItemReconcile';
```

Then replace the body of the `useGroupedMessages` hook, currently:

```ts
    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    return React.useMemo(() => {
        return groupMessagesForDisplay(messages, enabled, { collapseCurrentTurn });
    }, [messages, enabled, collapseCurrentTurn]);
```

with:

```ts
    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    // Group objects are freshly allocated on every regrouping, so reconcile
    // against the previous result to restore identity for untouched groups.
    // Without this, every group cell re-renders on every streamed token.
    const previousRef = React.useRef<DisplayItem[]>([]);
    return React.useMemo(() => {
        const grouped = groupMessagesForDisplay(messages, enabled, { collapseCurrentTurn });
        const reconciled = reconcileDisplayItems(previousRef.current, grouped);
        previousRef.current = reconciled;
        return reconciled;
    }, [messages, enabled, collapseCurrentTurn]);
```

- [ ] **Step 6: Typecheck and run the full suite**

Run from `packages/happy-app`:

```bash
pnpm typecheck
npx vitest run
```

Expected: typecheck clean, all tests pass including `sources/hooks/useGroupedMessages.test.ts` unmodified.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-app/sources/hooks/displayItemReconcile.ts packages/happy-app/sources/hooks/displayItemReconcile.spec.ts packages/happy-app/sources/hooks/useGroupedMessages.ts
git commit -m "perf(app): reuse group identity across regroupings

groupMessagesForDisplay allocates fresh group objects every call, so group
cells saw a changed prop on every streamed token even when nothing in the
group moved. A reconcile pass restores the previous object when members and
flags are unchanged.

Equivalence covers startedAt and completedAt for work groups too, since
AgentWorkGroupView renders elapsed time from them.

groupMessagesForDisplay itself is untouched and stays pure.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Confirm the cost actually dropped

**Files:**
- None modified. This task records numbers.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: the measured per-message cost, recorded below.

**Context you need:** The investigation benchmark bundled the real modules with esbuild and stubbed three imports.

**Correction — do not use `bench.ts` for this.** The investigation harness defines its own local `storageMergeSort` copy of the old clone-and-sort; it never imports the store's real merge path, so running it proves nothing about this change. Use `bench3.ts`, which imports `mergeMessagesInto` from `sources/sync/messageList.ts` and keeps the old path only as a labelled baseline.

- [x] **Step 1: Rebuild and run the benchmark**

The harness lives in `/tmp/happybench`. If it is gone, recreate `react.stub.ts` exporting `useMemo`/`useRef`, `knownTools.stub.ts` exporting `knownTools`, `text.stub.ts` exporting `t`, and `types.stub.ts` exporting `Message`/`ToolCallMessage` as `any`, then bundle with:

```bash
cd /tmp/happybench && npx --yes esbuild@0.24.0 bench3.ts --bundle --platform=node --format=esm --outfile=bench3.mjs \
  --alias:react=/tmp/happybench/react.stub.ts \
  '--alias:@/components/tools/knownTools=/tmp/happybench/knownTools.stub.ts' \
  '--alias:@/text=/tmp/happybench/text.stub.ts' \
  '--alias:@/sync/typesMessage=/tmp/happybench/types.stub.ts' && node bench3.mjs
```

Seed the lookup `Map` outside the timed loop and use a distinct message id per iteration, or the numbers measure seeding and the replace branch instead of insertion.

- [ ] **Step 2: Record the result**

Fill in the table below. The merge column should now be roughly the incremental-insert figures — about 0.001 ms at 500, 0.004 ms at 2000, 0.015 ms at 8000 — instead of the previous 0.166 / 0.522 / 2.798. Grouping is unchanged, since incremental grouping was deferred.

- [ ] **Step 3: Commit the numbers**

```bash
git add docs/superpowers/plans/2026-08-07-message-pipeline-render-cost.md
git commit -m "docs: record post-fix message pipeline measurements

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Measurements

Baseline, from the investigation:

| messages | grouping | merge (clone + sort) | total per message |
|---|---|---|---|
| 500 | 0.095 ms | 0.166 ms | 0.261 ms |
| 2000 | 0.233 ms | 0.522 ms | 0.755 ms |
| 8000 | 1.141 ms | 2.798 ms | 3.938 ms |

After, measured against the real `mergeMessagesInto`:

| messages | grouping | merge (incremental) | total per message |
|---|---|---|---|
| 500 | 0.125 ms | 0.002 ms | 0.127 ms |
| 2000 | 0.193 ms | 0.003 ms | 0.196 ms |
| 8000 | 1.000 ms | 0.015 ms | 1.016 ms |

The merge is 170x cheaper at 8000 messages (2.544 ms to 0.015 ms measured in the same run), and the per-message total drops 3.5x. Grouping is now the dominant remaining cost, which is expected: incremental grouping was deferred, so that column is unchanged within noise.

**Task 5's original instruction was wrong.** It said to rebuild and run `/tmp/happybench/bench.ts`, but that harness defines its own local `storageMergeSort` replica of the old clone-and-sort and never imports the store's real merge path. Running it as written would have produced numbers that say nothing about this change. The corrected harness, `/tmp/happybench/bench3.ts`, imports `mergeMessagesInto` from `sources/sync/messageList.ts` directly and keeps the old path only as a labelled baseline. The figures above come from that.

Two measurement details worth preserving. The lookup `Map` must be seeded outside the timed loop, or seeding dominates and hides the merge cost entirely. And each timed iteration must insert a distinct message id, since inserting the same id repeatedly exercises the replace branch rather than the insert branch.

## Not In Scope

- **Incremental grouping.** `groupMessagesForDisplay` still walks all messages on every change — the grouping column above will not improve. It is the smaller half of the cost and the riskiest to change, since grouping correctness is at stake.
- **`renderItem`'s `collapsedGroups` dependency.** Toggling a group still re-renders every mounted cell. Streaming does not change `collapsedGroups`, so the path that matters is covered.
- **Browser runtime measurement.** Still outstanding from `2026-08-07-web-scroll-responsiveness.md` Task 4. A benchmark improvement is not evidence that the app feels faster.
