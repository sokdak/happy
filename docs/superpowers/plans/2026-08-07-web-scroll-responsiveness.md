# Web Scroll Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the web app from degrading over extended use by bounding the navigation stack and tuning chat list virtualization.

**Architecture:** A new zero-import pure module decides whether opening a session should push, replace, or do nothing; `useNavigateToSession` and the notification handler feed it the current pathname. Separately, the chat `FlatList` gets explicit virtualization props so it stops inheriting React Native's `windowSize: 21` default. The pure module carries all the branching logic so it can be tested without mocking Expo, the store, or analytics.

**Tech Stack:** TypeScript, React 19.2, React Native 0.83.1, react-native-web 0.21, expo-router ~55.0.7, vitest (node environment, `@` aliased to `sources`).

## Global Constraints

- All changes confined to `packages/happy-app`. No protocol, server, or CLI changes.
- The `useNavigateToSession()` hook must keep returning `(sessionId: string) => void`. `hooks/useStartSessionFromDraft.test.ts` asserts single-argument calls and must pass untouched.
- Do not add `removeClippedSubviews` (breaks inverted lists and react-native-web) or `getItemLayout` (cell heights are markdown-driven and variable).
- Virtualization values start conservative: `windowSize={10}`, `maxToRenderPerBatch={5}`, `initialNumToRender={15}`. Tightening only after Task 4's measurements justify it.
- Run `pnpm typecheck` from `packages/happy-app` before any commit that changes TypeScript.
- Do not report improvement without the Task 4 traces.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/happy-app/sources/hooks/sessionNavigation.ts` (create) | Pure `resolveSessionNavigation`. Zero imports. All routing-decision branching lives here. |
| `packages/happy-app/sources/hooks/sessionNavigation.spec.ts` (create) | Unit tests for the resolver. |
| `packages/happy-app/sources/hooks/useNavigateToSession.ts` (modify) | Applies the resolved mode to the router. Gains a `currentPathname` parameter. |
| `packages/happy-app/sources/app/_layout.tsx` (modify) | Supplies the pathname to the notification-driven navigation via a ref. |
| `packages/happy-app/sources/components/ChatList.tsx` (modify) | Adds virtualization props to the message `FlatList`. |

---

### Task 1: Pure session-navigation resolver

**Files:**
- Create: `packages/happy-app/sources/hooks/sessionNavigation.ts`
- Test: `packages/happy-app/sources/hooks/sessionNavigation.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type SessionNavigationMode = 'push' | 'replace' | 'noop'` and `resolveSessionNavigation(currentPathname: string, targetSessionId: string): SessionNavigationMode`. Task 2 imports both.

**Context you need:** Routes under `/session/` are `app/(app)/session/[id].tsx` (`/session/{id}`), its sub-routes `info`, `files`, `file`, `message/[messageId]`, and one static sibling `app/(app)/session/recent.tsx` (`/session/recent`). `recent` has the same shape as a session id and must not be mistaken for one.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-app/sources/hooks/sessionNavigation.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveSessionNavigation } from './sessionNavigation';

describe('resolveSessionNavigation', () => {
    it('pushes from the home screen', () => {
        expect(resolveSessionNavigation('/', 'session-a')).toBe('push');
    });

    it('pushes from an unrelated screen', () => {
        expect(resolveSessionNavigation('/settings', 'session-a')).toBe('push');
    });

    it('pushes from the recent list so back still returns to it', () => {
        expect(resolveSessionNavigation('/session/recent', 'session-a')).toBe('push');
    });

    it('pushes for a bare /session/ path', () => {
        expect(resolveSessionNavigation('/session/', 'session-a')).toBe('push');
    });

    it('pushes for an empty pathname', () => {
        expect(resolveSessionNavigation('', 'session-a')).toBe('push');
    });

    it('replaces when switching to a different session', () => {
        expect(resolveSessionNavigation('/session/session-b', 'session-a')).toBe('replace');
    });

    it('is a no-op when already on the target session chat', () => {
        expect(resolveSessionNavigation('/session/session-a', 'session-a')).toBe('noop');
    });

    it('replaces from a different session sub-route', () => {
        expect(resolveSessionNavigation('/session/session-b/info', 'session-a')).toBe('replace');
    });

    it('replaces from the target session own sub-route', () => {
        expect(resolveSessionNavigation('/session/session-a/info', 'session-a')).toBe('replace');
    });

    it('treats a percent-encoded id as the same session', () => {
        expect(resolveSessionNavigation('/session/a%2Fb', 'a/b')).toBe('noop');
    });

    it('does not throw on malformed percent-encoding', () => {
        expect(resolveSessionNavigation('/session/%E0%A4%A', 'session-a')).toBe('replace');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/happy-app`: `npx vitest run sources/hooks/sessionNavigation.spec.ts`
Expected: FAIL — cannot resolve `./sessionNavigation`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/happy-app/sources/hooks/sessionNavigation.ts`:

```ts
/**
 * Pure navigation-mode decisions for opening a session.
 *
 * Deliberately free of imports so it can be unit-tested without mocking
 * expo-router, the sync store, or analytics.
 */

export type SessionNavigationMode = 'push' | 'replace' | 'noop';

const SESSION_PATH_PREFIX = '/session/';

/**
 * Routes that live under /session/ but are not session ids.
 * `/session/recent` is app/(app)/session/recent.tsx — a browse surface, so we
 * push over it and leave its back behaviour exactly as it is today.
 */
const STATIC_SESSION_CHILD_ROUTES = new Set(['recent']);

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        // Malformed percent-encoding: compare the raw segment instead. Worst
        // case is a redundant replace, never a lost navigation.
        return segment;
    }
}

export function resolveSessionNavigation(
    currentPathname: string,
    targetSessionId: string,
): SessionNavigationMode {
    if (!currentPathname.startsWith(SESSION_PATH_PREFIX)) {
        return 'push';
    }

    const rest = currentPathname.slice(SESSION_PATH_PREFIX.length);
    if (rest.length === 0) {
        return 'push';
    }

    const slashIndex = rest.indexOf('/');
    const hasSubRoute = slashIndex !== -1;
    const sessionSegment = hasSubRoute ? rest.slice(0, slashIndex) : rest;

    if (!hasSubRoute && STATIC_SESSION_CHILD_ROUTES.has(sessionSegment)) {
        return 'push';
    }

    if (!hasSubRoute && decodeSegment(sessionSegment) === targetSessionId) {
        return 'noop';
    }

    return 'replace';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `packages/happy-app`: `npx vitest run sources/hooks/sessionNavigation.spec.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/hooks/sessionNavigation.ts packages/happy-app/sources/hooks/sessionNavigation.spec.ts
git commit -m "feat(app): add pure session navigation mode resolver

Decides push vs replace vs noop when opening a session. Kept import-free so
it is testable without mocking expo-router, the store, or analytics.

/session/recent is excluded explicitly: it is a static route with the same
shape as a session id, and pushing over it preserves its back behaviour.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Apply the resolved mode when navigating

**Files:**
- Modify: `packages/happy-app/sources/hooks/useNavigateToSession.ts` (whole file, currently 20 lines)
- Modify: `packages/happy-app/sources/app/_layout.tsx:8`, `:209`, `:321`

**Interfaces:**
- Consumes: `resolveSessionNavigation` from Task 1. The `SessionNavigationMode` type is inferred and does not need importing.
- Produces: `navigateToSession(router: Router, sessionId: string, currentPathname: string): void` and `useNavigateToSession(): (sessionId: string) => void`. The hook's signature is unchanged; every other consumer (`components/SessionsList.tsx`, `components/ActiveSessionsGroupCompact.tsx`, `hooks/useSessionQuickActions.ts`, `hooks/useStartSessionFromDraft.ts`, `components/CommandPalette/CommandPaletteProvider.tsx`, `app/(app)/machine/[id].tsx`, `app/(app)/new/index.tsx`, `app/(app)/session/recent.tsx`) uses the hook and needs no edit.

**Context you need:** This project has `typedRoutes: true` (`app.config.js:217-218`), so route strings are type-checked. `router.replace` with this exact template shape is already proven to typecheck — see `components/DuplicateSheet.tsx:157`, which calls `router.replace(`/session/${result.sessionId}`)`. No cast is needed.

`navigateToSession` is called directly, without the hook, in exactly one place: `app/_layout.tsx:321`, inside `handleNotificationResponse`. That callback is declared `React.useCallback(async (response) => {...}, [router])` and is itself a dependency of the effect at `_layout.tsx:331-356`, which registers a notification listener and reads the last notification response. Adding `pathname` to the callback's dependency list would tear down and re-register that listener on every navigation. Use a ref instead and leave `[router]` alone.

- [ ] **Step 1: Replace the contents of `useNavigateToSession.ts`**

```ts
import type { Router } from "expo-router"
import { usePathname, useRouter } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';
import { resolveSessionNavigation } from './sessionNavigation';

export function navigateToSession(router: Router, sessionId: string, currentPathname: string) {
    const mode = resolveSessionNavigation(currentPathname, sessionId);
    if (mode === 'noop') {
        return;
    }

    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    const href = `/session/${encodeURIComponent(sessionId)}`;
    if (mode === 'replace') {
        // Session-to-session moves replace rather than push. Pushing left every
        // visited session screen mounted — with its ChatList and store
        // subscriptions — for the lifetime of the tab.
        router.replace(href);
        return;
    }
    router.push(href);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    return (sessionId: string) => {
        navigateToSession(router, sessionId, pathname);
    }
}
```

- [ ] **Step 2: Add the pathname import in `app/_layout.tsx`**

Line 8 currently reads:

```ts
import { useRouter } from 'expo-router';
```

Change it to:

```ts
import { usePathname, useRouter } from 'expo-router';
```

- [ ] **Step 3: Add the pathname ref next to the router in `app/_layout.tsx`**

Line 209 currently reads `const router = useRouter();`. Insert immediately after it:

```ts
    const pathname = usePathname();
    // Held in a ref so handleNotificationResponse keeps a stable identity. It
    // is a dependency of the notification effect below, which would otherwise
    // re-register its listener on every navigation.
    const pathnameRef = React.useRef(pathname);
    pathnameRef.current = pathname;
```

- [ ] **Step 4: Pass the pathname at the call site in `app/_layout.tsx`**

Line 321 currently reads:

```ts
            navigateToSession(router, sessionId);
```

Change it to:

```ts
            navigateToSession(router, sessionId, pathnameRef.current);
```

Leave the `useCallback` dependency list on `handleNotificationResponse` as `[router]`.

- [ ] **Step 5: Typecheck and run the full test suite**

Run from `packages/happy-app`:

```bash
pnpm typecheck
npx vitest run
```

Expected: typecheck clean; all tests pass, including `sources/hooks/useStartSessionFromDraft.test.ts` unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/hooks/useNavigateToSession.ts packages/happy-app/sources/app/_layout.tsx
git commit -m "fix(app): bound the session navigation stack

Switching between sessions pushed a new screen every time and nothing was
ever released: freezeOnBlur, enableFreeze, and detachInactiveScreens are
unused, so each visited session left a mounted SessionView with its ChatList
and live store subscriptions for the lifetime of the tab. That is the one
contributor to web sluggishness that grows purely with elapsed usage.

Session-to-session moves now replace. Back from a session returns to home.

The notification call site reads the pathname from a ref so
handleNotificationResponse keeps a stable identity — it is a dependency of
the effect that registers the notification listener.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Tune chat list virtualization

**Files:**
- Modify: `packages/happy-app/sources/components/ChatList.tsx:452`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks. Task 4 measures its effect.

**Context you need:** The `FlatList` starts at `ChatList.tsx:421` and sets none of the virtualization props, so it inherits React Native's defaults — `windowSize: 21`, `maxToRenderPerBatch: 10`, `initialNumToRender: 10`. `windowSize: 21` keeps roughly twenty-one viewport-heights of cells mounted. `components/SessionsList.tsx:404-406` already sets `windowSize={5} maxToRenderPerBatch={8} initialNumToRender={12}` on a much lighter list of plain rows. The list here is `inverted` and uses `maintainVisibleContentPosition` plus `onEndReached` pagination, and its cells are markdown, so heights vary and `getItemLayout` is not available.

- [ ] **Step 1: Add the three props**

Line 452 currently reads `                scrollEventThrottle={16}`. Insert immediately after it:

```tsx
                // Without these, this list inherits FlatList's windowSize of
                // 21 — about twenty-one viewport-heights of markdown and tool
                // cells kept mounted. It is the heaviest surface in the app,
                // and SessionsList already tunes far lighter rows.
                //
                // Values are deliberately conservative. Cell heights are
                // markdown-driven so getItemLayout cannot be supplied, and an
                // over-tight window on an inverted list can show blank regions
                // during fast scrolling. removeClippedSubviews is left off: it
                // is known to break inverted lists and react-native-web.
                windowSize={10}
                maxToRenderPerBatch={5}
                initialNumToRender={15}
```

- [ ] **Step 2: Typecheck**

Run from `packages/happy-app`: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-app/sources/components/ChatList.tsx
git commit -m "perf(app): tune chat list virtualization

The message list set no virtualization props, so it inherited windowSize 21
— roughly twenty-one viewport-heights of markdown and tool cells mounted at
once. SessionsList already tunes a far lighter list of plain rows; the
heaviest surface in the app was the untuned one.

Conservative values: heights are markdown-driven so getItemLayout is not
available, and an over-tight window on an inverted list can show blank
regions on fast scroll. To be confirmed or tightened against measurements.

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Measure before and after, then finalize the virtualization values

**Files:**
- Modify (only if measurements justify it): `packages/happy-app/sources/components/ChatList.tsx`

**Interfaces:**
- Consumes: the branch state produced by Tasks 1-3.
- Produces: recorded numbers, plus a decision to keep or tighten Fix B's values.

**Context you need:** The workspace has no `node_modules` — nothing is installed anywhere in the repo, so this task starts with an install. Dependencies are identical between `origin/main` and this branch, so a single install serves both measurement runs and you can switch commits without reinstalling. You need an account with at least ten sessions, one of which has a long chat history, to make the comparison meaningful.

- [ ] **Step 1: Install dependencies**

Run from the repository root:

```bash
pnpm install
```

Expected: completes; `node_modules` present at root and in `packages/happy-app`. This takes several minutes on a cold pnpm store.

- [ ] **Step 2: Capture the baseline on origin/main**

```bash
git checkout origin/main
pnpm --filter happy-app web
```

In the browser, with DevTools **closed** (open DevTools retains console-logged objects and skews memory):

1. Load the app on the home screen. Open DevTools console only to run the snippet, then record `document.querySelectorAll('*').length`. Call this `domHome`.
2. Open one session. Record the same count as `domOneSession`.
3. Switch between ten different sessions using the sidebar or session list. Record the count as `domTenSwitches`.
4. Press back once. Record where you land.

Then open the long chat and, while scrolling continuously for about five seconds, run this frame-time sampler in the console:

```js
(() => {
  const gaps = [];
  let last = performance.now();
  function frame(now) {
    gaps.push(now - last);
    last = now;
    if (gaps.length < 300) return requestAnimationFrame(frame);
    const s = gaps.slice(30).sort((a, b) => a - b);
    console.log({
      p50: s[Math.floor(s.length * 0.5)],
      p95: s[Math.floor(s.length * 0.95)],
      worst: s[s.length - 1],
    });
  }
  requestAnimationFrame(frame);
})();
```

Record `p50`, `p95`, `worst`.

- [ ] **Step 3: Capture the same measurements on the fix branch**

```bash
git checkout fix/web-scroll-responsiveness
pnpm --filter happy-app web
```

Repeat every measurement from Step 2 identically.

- [ ] **Step 4: Compare against expectations**

- `domTenSwitches` should stay close to `domOneSession` instead of growing with each switch. Growth proportional to the number of switches means Fix A is not taking effect — verify `resolveSessionNavigation` is returning `replace` by logging the mode.
- Back from a session should land on home, confirming the bounded stack.
- Scrolling `p95` and `worst` frame times should improve. If they did not move at all, Fix B's window is not the binding constraint and the remaining cost is likely deferred finding 3 (the full re-sort and re-group per incoming message) — record that and do not tighten values blindly.
- Watch for blank regions while scrolling fast. If any appear, `windowSize={10}` is already too tight and should go back up.

- [ ] **Step 5: Decide the final values**

If no blank regions appeared and frame times improved, optionally try `windowSize={5}` to match `SessionsList` and re-run Step 3's scroll measurement. Keep the tighter value only if it improves frame times **and** produces no blank regions. Otherwise keep `windowSize={10}`.

- [ ] **Step 6: Commit the measurements**

Record the numbers in the plan file under a "Measurements" heading, plus the final chosen values, then:

```bash
git add docs/superpowers/plans/2026-08-07-web-scroll-responsiveness.md packages/happy-app/sources/components/ChatList.tsx
git commit -m "docs: record web responsiveness before/after measurements

Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Measurements

To be filled in by Task 4. Leave this section in place; it is the evidence any improvement claim must cite.

| Metric | origin/main | fix branch |
|---|---|---|
| `domHome` | | |
| `domOneSession` | | |
| `domTenSwitches` | | |
| back from session lands on | | |
| scroll `p50` (ms) | | |
| scroll `p95` (ms) | | |
| scroll `worst` (ms) | | |

Final virtualization values: _pending Task 4._

## Not In Scope

Carried over from the spec, with measurements already gathered during investigation:

- **Full re-sort and re-group per incoming message.** `sync/storage.ts:698-705` shallow-copies the whole `messagesMap` and re-sorts every message on each socket message; `hooks/useGroupedMessages.ts:63-85` then walks all messages three more times. Measured in Node with no React: 0.261 ms per incoming message at 500 messages, 0.755 ms at 2000, 3.938 ms at 8000.
- **Group cells can never be memoized.** `groupMessagesForDisplay` allocates fresh group objects per call and `ChatList.tsx:319,330` passes a new `onToggle` closure each render, defeating `React.memo` on `ToolGroupView` and `AgentWorkGroupView`.
- **`sessionMessages` is never evicted** — every visited session's messages are retained until the session is deleted.
- **Memoizing the function returned by `useNavigateToSession`.** It allocates a new closure per render today. Stabilizing it with `useCallback` would be on-goal but is not part of the approved design.
- Reducing the worst-case stack depth from three to two, which needs `router.dismissTo` or `navigation.reset`.
