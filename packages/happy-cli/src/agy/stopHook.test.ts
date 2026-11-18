import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { projectPath } from '@/projectPath';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyStopHookEnabled, AgyStopHook, AgyStopPolicy, STOP_HOOK_LIMITS, type StopHookLimits } from './stopHook';

const payload = (executionNum = 0, extra = {}) => ({ conversationId: 'session', hookEventName: 'Stop',
  terminationReason: 'NO_TOOL_CALL', fullyIdle: false, continuationActive: false, executionNum, ...extra });
function policy() { const p = new AgyStopPolicy(); p.begin('session'); return p; }
const hooks: AgyStopHook[] = [];
afterEach(() => { for (const hook of hooks.splice(0)) hook.close(); });
async function hook(limits: Partial<StopHookLimits> = { maxBackoffMs: 0 }) {
  const h = await AgyStopHook.create(limits); hooks.push(h); h.policy.begin('session'); return h;
}
function invokeHook(h: AgyStopHook, input: unknown): Promise<any> {
  const config = JSON.parse(readFileSync(join(h.workspace, '.agents/hooks.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', ['-c', config['happy-acp-background'].Stop[0].command], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) reject(err); else { try { expect(stderr).toBe(''); resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }
    });
    child.stdin!.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

describe('AGY Stop policy', () => {
  it('is opt-in and rejects typos instead of silently enabling', () => {
    expect(agyStopHookEnabled('0')).toBe(false); expect(agyStopHookEnabled('1')).toBe(true);
    expect(() => agyStopHookEnabled('true')).toThrow('0 or 1');
  });
  it('continues finite background work and confirms idle without synthetic user prompts', () => {
    const p = policy();
    expect(p.decide(payload())).toMatchObject({ decision: 'continue' });
    p.progress();
    expect(p.decide(payload(1, { fullyIdle: true }))).toEqual({});
    expect(p.finish()).toBeUndefined();
    expect(p.decide(payload(2))).toEqual({});
  });
  it.each(['USER_CANCELED', 'ERROR', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS', 'MAX_TOKEN_BUDGET_EXCEEDED', 'TERMINAL_STEP_TYPE', 'unknown'])('never overrides native %s', terminationReason => {
    const p = policy(); expect(p.decide(payload(0, { terminationReason }))).toEqual({});
    expect(p.finish()).toContain('native stop');
  });
  it.each([null, [], {}, payload(0, { fullyIdle: 'false' }), payload(-1), payload(NaN),
    payload(0, { continuationActive: undefined }), payload(0, { hookEventName: 'PreInvocation' })])('does not continue malformed input %j', value => {
    const p = policy(); expect(p.decide(value)).toEqual({}); expect(p.finish()).toBeDefined();
  });
  it('isolates Stop observations for other conversations sharing the hook workspace', () => {
    const p = policy();
    const foreignStop = payload(7, { conversationId: 'child', fullyIdle: true });
    expect(p.decide(foreignStop)).toEqual({});
    expect(p.finish()).toContain('did not report');
    p.begin('session');
    expect(p.decide(payload(0)).decision).toBe('continue');
    const waiting = p.snapshot();
    expect(p.decide(foreignStop)).toEqual({});
    expect(p.snapshot()).toEqual(waiting);
    expect(p.decide(payload(1, { fullyIdle: true }))).toEqual({});
    expect(p.finish()).toBeUndefined();
  });
  it('requires an idle observation at least as recent as the pending execution', () => {
    const p = policy();
    expect(p.decide(payload(2)).decision).toBe('continue');
    expect(p.decide(payload(1, { fullyIdle: true }))).toEqual({});
    expect(p.finish()).toContain('not confirmed');
  });
  it('keeps a confirmed idle observation when an earlier busy report arrives late', () => {
    const p = policy();
    expect(p.decide(payload(2, { fullyIdle: true }))).toEqual({});
    expect(p.decide(payload(1))).toEqual({});
    expect(p.decide(payload(2))).toEqual({});
    expect(p.finish()).toBeUndefined();
  });
  it('bounds repeated waiting for servers/watchers without claiming they completed', () => {
    const p = policy();
    const limit = STOP_HOOK_LIMITS.maxStalledContinuations;
    for (let i = 0; i < limit; i++) expect(p.decide(payload(i)).decision).toBe('continue');
    expect(p.decide(payload(limit))).toEqual({});
    p.progress(); expect(p.decide(payload(limit + 1))).toEqual({});
    expect(p.finish()).toContain('no completed tool progress');
  });
  it('permits chained tasks but keeps the total cap despite progress or continuationActive=false', () => {
    const p = policy();
    const limit = STOP_HOOK_LIMITS.maxContinuations;
    for (let i = 0; i < limit; i++) { p.progress(); expect(p.decide(payload(i)).decision).toBe('continue'); }
    p.progress(); expect(p.decide(payload(limit))).toEqual({}); expect(p.finish()).toContain('continuation limit');
  });
  it('applies progressive backoff per stalled continuation, resets backoff and timer on progress, and clamps to remaining time', () => {
    let now = 1_000;
    const p = new AgyStopPolicy(STOP_HOOK_LIMITS, () => now);
    p.begin('session');
    expect(p.decide(payload(0))).toMatchObject({ decision: 'continue', reason: expect.stringContaining('do not create new schedule timers') });
    expect(p.plannedDelayMs()).toBe(5_000);
    expect(p.decide(payload(1)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(10_000);
    expect(p.decide(payload(2)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(15_000);
    expect(p.decide(payload(3)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(20_000);
    expect(p.decide(payload(4)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(25_000);
    expect(p.decide(payload(5)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(30_000);
    expect(p.decide(payload(6)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(30_000);
    now = 1_000 + STOP_HOOK_LIMITS.maxContinuationMs + 50_000;
    p.progress();
    expect(p.decide(payload(7)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(5_000);
    now = now + STOP_HOOK_LIMITS.maxContinuationMs - 3_200;
    expect(p.decide(payload(8)).decision).toBe('continue');
    expect(p.plannedDelayMs()).toBe(3_200);
  });
  it('bounds elapsed continuation time and rejects duplicated native executions', () => {
    let now = 0; const p = new AgyStopPolicy(STOP_HOOK_LIMITS, () => now); p.begin('session');
    p.decide(payload()); now = STOP_HOOK_LIMITS.maxContinuationMs;
    expect(p.decide(payload(1))).toEqual({}); expect(p.finish()).toContain('time limit');
    const q = policy(); q.decide(payload()); expect(q.decide(payload())).toEqual({}); expect(q.finish()).toContain('repeated');
  });
  it('fences cancelled, finished and earlier-turn requests', () => {
    const p = policy(); const old = p.epoch();
    p.cancel(); expect(p.decide(payload())).toEqual({});
    p.begin('session'); expect(p.decide(payload(), old)).toEqual({});
    expect(p.decide(payload()).decision).toBe('continue');
  });
  it('reports missing hooks and does not clear earlier errors with later idle input', () => {
    expect(policy().finish()).toContain('did not report');
    const p = policy(); p.decide({}); p.decide(payload(1, { fullyIdle: true }));
    expect(p.finish()).toContain('invalid');
  });
  it('invalidates idle when a hook cannot identify its conversation', () => {
    const p = policy();
    p.decide(payload(0, { fullyIdle: true }));
    expect(p.decide(payload(1, { conversationId: '' }))).toEqual({});
    expect(p.finish()).toContain('invalid hook input');
  });
});

describe.skipIf(process.platform === 'win32')('packaged command hook and private controller', () => {
  it('returns promptly when the controller has been retired', async () => {
    const h = await hook(); h.close();
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [join(projectPath(), 'scripts/agy-stop-hook.cjs'), h.socketPath], { timeout: 4000 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify(payload()));
    });
    expect(JSON.parse(output)).toEqual({});
  });
  it('runs the shipped Node hook without forwarding prompts/paths or mutating the workspace', async () => {
    const h = await hook();
    expect(statSync(h.workspace).mode & 0o077).toBe(0);
    expect(h.socketPath.startsWith(h.workspace)).toBe(false);
    const result = await invokeHook(h, payload(0, { transcriptPath: '/secret', lastUserInput: 'password=private' }));
    expect(result.decision).toBe('continue');
    expect(JSON.stringify(h.policy.snapshot())).not.toMatch(/private|secret/);
    await invokeHook(h, payload(1, { fullyIdle: true })); expect(h.policy.finish()).toBeUndefined();
  });
  it('accepts large native prompts while forwarding only lifecycle fields', async () => {
    const h = await hook();
    const result = await invokeHook(h, payload(0, { lastUserInput: 'p'.repeat(1024 * 1024), fullyIdle: true }));
    expect(result).toEqual({}); expect(h.policy.finish()).toBeUndefined();
    expect(JSON.stringify(h.policy.snapshot()).length).toBeLessThan(500);
  });
  it('invalidates prior idle state when a subsequent hook socket closes mid-request', async () => {
    const h = await hook();
    await invokeHook(h, payload(0, { fullyIdle: true }));
    const socket = createConnection(h.socketPath);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.end('{');
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.policy.finish()).toContain('invalid');
  });
  it('isolates sibling sessions and handles malformed stdin', async () => {
    const a = await hook(), b = await hook(); a.policy.cancel();
    expect(await invokeHook(a, payload())).toEqual({});
    expect((await invokeHook(b, payload())).decision).toBe('continue');
    expect(await invokeHook(b, '{not JSON')).toEqual({});
    expect(b.policy.finish()).toContain('invalid');
  });
  it('rejects delayed socket payloads from a previous turn and cleans up', async () => {
    const h = await hook();
    const socket = createConnection(h.socketPath); socket.setEncoding('utf8');
    await new Promise<void>(resolve => socket.once('connect', resolve));
    // Give the server its accept callback before rotating the turn.
    await new Promise(resolve => setImmediate(resolve));
    h.policy.cancel(); h.policy.begin('session');
    const response = new Promise<string>(resolve => socket.once('data', resolve));
    socket.write(JSON.stringify(payload()) + '\n'); expect(JSON.parse(await response)).toEqual({});
    socket.destroy(); h.close(); h.close(); expect(existsSync(h.workspace)).toBe(false);
  });
  it('configures default hook timeouts above maxBackoffMs and holds stalled continuations', async () => {
    const defaults = await AgyStopHook.create();
    hooks.push(defaults);
    const defaultConfig = JSON.parse(readFileSync(join(defaults.workspace, '.agents/hooks.json'), 'utf8'));
    expect(defaultConfig['happy-acp-background'].Stop[0].timeout).toBeGreaterThanOrEqual(20);

    const h = await hook({ initialBackoffMs: 120, maxBackoffMs: 240 });
    const startedAt = Date.now();
    const res = await invokeHook(h, payload(0));
    expect(res.decision).toBe('continue');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });
  it('wakes an in-flight backoff immediately on command progress, cancellation, or poisoned sibling socket', async () => {
    // Longer than invokeHook's client deadline, so a reply must come from a wakeup.
    const limits = { initialBackoffMs: 10_000, maxBackoffMs: 10_000 };
    const progressing = await hook(limits);
    const pendingProgress = invokeHook(progressing, payload(0));
    await vi.waitFor(() => expect(progressing.policy.snapshot()?.count).toBe(1));
    progressing.policy.progress();
    expect((await pendingProgress).decision).toBe('continue');

    const cancelling = await hook(limits);
    const pendingCancel = invokeHook(cancelling, payload(0));
    await vi.waitFor(() => expect(cancelling.policy.snapshot()?.count).toBe(1));
    cancelling.policy.cancel();
    expect(await pendingCancel).toEqual({});

    const poisoned = await hook(limits);
    const pendingPoisoned = invokeHook(poisoned, payload(0));
    await vi.waitFor(() => expect(poisoned.policy.snapshot()?.count).toBe(1));
    await invokeHook(poisoned, '{bad json');
    expect(await pendingPoisoned).toEqual({});
    expect(poisoned.policy.finish()).toContain('invalid');
  });
  it('records unconfirmed issue if the hook client disconnects during backoff wait', async () => {
    const h = await hook({ initialBackoffMs: 2_000, maxBackoffMs: 2_000 });
    const socket = createConnection(h.socketPath);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write(JSON.stringify(payload(0)) + '\n');
    await new Promise(resolve => setTimeout(resolve, 40));
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(h.policy.finish()).toContain('invalid');
  });
  it.each([true, false])('retires a pending reply when a newer Stop reports fullyIdle=%s', async fullyIdle => {
    const h = await hook({ initialBackoffMs: 10_000, maxBackoffMs: 10_000 });
    const first = invokeHook(h, payload(0));
    await vi.waitFor(() => expect(h.policy.snapshot()?.count).toBe(1));
    const next = invokeHook(h, payload(1, { fullyIdle }));
    expect(await first).toEqual({});
    if (fullyIdle) {
      expect(await next).toEqual({});
    } else {
      h.policy.progress();
      expect((await next).decision).toBe('continue');
      await invokeHook(h, payload(2, { fullyIdle: true }));
    }
    expect(h.policy.finish()).toBeUndefined();
  });
});
