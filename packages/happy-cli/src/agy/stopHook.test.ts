import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { projectPath } from '@/projectPath';
import { afterEach, describe, expect, it } from 'vitest';
import { agyStopHookEnabled, AgyStopHook, AgyStopPolicy, STOP_HOOK_LIMITS } from './stopHook';

const payload = (executionNum = 0, extra = {}) => ({ conversationId: 'session', hookEventName: 'Stop',
  terminationReason: 'NO_TOOL_CALL', fullyIdle: false, continuationActive: false, executionNum, ...extra });
function policy() { const p = new AgyStopPolicy(); p.begin('session'); return p; }
const hooks: AgyStopHook[] = [];
afterEach(() => { for (const hook of hooks.splice(0)) hook.close(); });
async function hook() { const h = await AgyStopHook.create(); hooks.push(h); h.policy.begin('session'); return h; }
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
    payload(0, { continuationActive: undefined }), payload(0, { hookEventName: 'PreInvocation' }), payload(0, { conversationId: 'other' })])('does not continue malformed/mismatched input %j', value => {
    const p = policy(); expect(p.decide(value)).toEqual({}); expect(p.finish()).toBeDefined();
  });
  it('bounds repeated waiting for servers/watchers without claiming they completed', () => {
    const p = policy();
    for (let i = 0; i < STOP_HOOK_LIMITS.maxStalledContinuations; i++) expect(p.decide(payload(i)).decision).toBe('continue');
    expect(p.decide(payload(4))).toEqual({});
    p.progress(); expect(p.decide(payload(5))).toEqual({});
    expect(p.finish()).toContain('no completed tool progress');
  });
  it('permits chained tasks but keeps the total cap despite progress or continuationActive=false', () => {
    const p = policy();
    for (let i = 0; i < STOP_HOOK_LIMITS.maxContinuations; i++) { p.progress(); expect(p.decide(payload(i)).decision).toBe('continue'); }
    p.progress(); expect(p.decide(payload(12))).toEqual({}); expect(p.finish()).toContain('continuation limit');
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
});
