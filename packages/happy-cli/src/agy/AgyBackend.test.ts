import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { AgyBackend, type SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';

/** Minimal fake of a spawned child process for driving AgyBackend in tests. */
function makeFakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  return { child, stdout, stderr };
}

describe('AgyBackend', () => {
  it.each([
    ['Gemini 3.8 Flash', 'high', 'High'],
    ['Gemini 4 Argon', 'high', 'High'],
    ['Gemini 4 Carbon', 'high', 'High'],
    ['Gemini 4 Hydrogen', 'high', 'High'],
    ['Gemini 4 Hydrogen', 'xhigh', 'XHigh'],
  ])('passes %s with %s effort to agy --model', async (model, effort, label) => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model,
      effort: 'medium',
      spawnFn,
      resolveConversationId: () => null,
    });

    backend.setEffort(effort);
    const turn = backend.sendPrompt('/work', 'hi');
    child.emit('close', 0);
    await turn;

    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const modelIndex = args.indexOf('--model');
    expect(args[modelIndex + 1]).toBe(`${model} (${label})`);
  });

  it('maps a successful turn: running → model-output(s) → idle', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');

    // Stream NDJSON records split across arbitrary stdout chunks, then exit cleanly.
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"cid-stream-1"}\n{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_',
    );
    stdout.emit(
      'data',
      'delta":"Hello "}}\n{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"world"}}\n{"event":"result","result":{"status":"SUCCESS","response":"Hello world"}}\n',
    );
    child.emit('close', 0);

    await expect(turn).resolves.toBeUndefined();

    const types = messages.map((m) => m.type);
    expect(types[0]).toBe('status');
    expect(messages[0]).toMatchObject({ type: 'status', status: 'running' });
    // agy --print hangs unless stdin is closed: spawn must give the child an
    // empty stdin (immediate EOF), not an open pipe.
    const spawnOpts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(spawnOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    const spawnArgs = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const timeoutIdx = spawnArgs.indexOf('--print-timeout');
    expect(timeoutIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[timeoutIdx + 1]).toBe('30m');
    expect(spawnArgs.slice(-4)).toEqual(['--output-format', 'stream-json', '--print', 'hi']);

    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'Hello world' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('emits an error status and rejects on non-zero exit', async () => {
    const { child, stderr } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');
    stderr.emit('data', '\u001b[31mUnknown model Gemini 3.8 Flash\u001b[0m\n');
    child.emit('close', 1);

    await expect(turn).rejects.toThrow(/exited with code 1: Unknown model Gemini 3\.8 Flash/);
    expect(messages.at(-1)).toMatchObject({
      type: 'status',
      status: 'error',
      detail: 'agy exited with code 1: Unknown model Gemini 3.8 Flash',
    });
  });

  it('resumes the captured conversation id on the next turn', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    // No conversation at start; agy records one after the first turn.
    let recorded: string | null = null;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    // First turn: fresh (no --conversation), then a conversation id appears.
    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'cid-xyz';
    current.child.emit('close', 0);
    await t1;

    expect(spawnCalls[0]).not.toContain('--conversation');

    // Second turn: resumes the captured id.
    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('cid-xyz');
  });

  it('starts fresh instead of resuming a pre-existing cwd conversation (cross-resume guard)', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    // The cwd cache already holds a conversation from another (possibly live) session.
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => 'other-sessions-conversation',
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    current.child.emit('close', 0);
    await t1;
    expect(spawnCalls[0]).not.toContain('--conversation');

    // The cache entry never changed, so it was not ours to adopt.
    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;
    expect(spawnCalls[1]).not.toContain('--conversation');
  });

  it('adopts the id recorded during the first turn even when a stale entry existed', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = 'stale-old';
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'fresh-1'; // our turn created a new conversation
    current.child.emit('close', 0);
    await t1;
    expect(spawnCalls[0]).not.toContain('--conversation');

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;
    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('fresh-1');
  });

  it('re-snapshots the cache every turn while unpinned: a foreign write between turns is not adopted', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = 'stale-S';
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    // Turn 1: cache stays at the stale value → nothing to adopt.
    const t1 = backend.sendPrompt('/work', 'first');
    current.child.emit('close', 0);
    await t1;

    // While idle, a foreign session writes a new id. If the backend kept using
    // turn 1's snapshot ('stale-S'), turn 2's close would mis-adopt 'foreign-F'.
    recorded = 'foreign-F';

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    current = makeFakeChild();
    const t3 = backend.sendPrompt('/work', 'third');
    current.child.emit('close', 0);
    await t3;

    for (const call of spawnCalls) {
      expect(call).not.toContain('--conversation');
    }
  });

  it('keeps the pinned conversation when another session updates the cache', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = null;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'mine';
    current.child.emit('close', 0);
    await t1;

    // A second agy session in the same cwd finishes a turn: cache now points elsewhere.
    recorded = 'theirs';

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    current = makeFakeChild();
    const t3 = backend.sendPrompt('/work', 'third');
    current.child.emit('close', 0);
    await t3;

    for (const call of [spawnCalls[1], spawnCalls[2]]) {
      const idx = call.indexOf('--conversation');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(call[idx + 1]).toBe('mine');
    }
  });

  it('emits only one error when error is followed by close (no double-emit)', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');

    // Node fires both 'error' and 'close' on spawn failure.
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null);

    await expect(turn).rejects.toThrow(/ENOENT/);
    expect(messages.filter((m) => m.type === 'status' && m.status === 'error')).toHaveLength(1);
  });

  it('cancel() kills the running child', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');
    await backend.cancel();
    expect(child.kill).toHaveBeenCalled();

    // The kill surfaces as a non-zero close, which rejects the turn.
    child.emit('close', null);
    await expect(turn).rejects.toThrow();
  });

  it('delivers intermediate progress and tool envelopes before the child process exits', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'yolo',
      spawnFn,
      resolveConversationId: () => null,
    });

    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();
    backend.onMessage((msg) => envelopes.push(...mapper.mapMessage(msg)));

    const turn = backend.sendPrompt('/work', 'investigate');

    stdout.emit(
      'data',
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '로그를 먼저 확인하겠습니다.\n',
        },
      })}\n${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { parameters: { CommandLine: 'git status -sb' } },
        },
      })}\n`,
    );

    // Before the command finishes or the process exits, Happy already has the intermediate text + active tool card!
    expect(envelopes.map((e) => e.ev)).toEqual([
      { t: 'turn-start' },
      { t: 'text', text: '로그를 먼저 확인하겠습니다.' },
      {
        t: 'tool-call-start',
        call: expect.any(String),
        name: 'Bash',
        title: 'Bash',
        description: 'Running Bash',
        args: { command: 'git status -sb' },
      },
    ]);

    stdout.emit(
      'data',
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { output: '## main' },
        },
      })}\n${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '상태가 정상입니다.',
        },
      })}\n${JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: '상태가 정상입니다.' },
      })}\n`,
    );
    child.emit('close', 0);
    await turn;
    envelopes.push(...mapper.endTurn('completed'));

    expect(envelopes.map((e) => e.ev.t)).toEqual([
      'turn-start',
      'text',
      'tool-call-start',
      'tool-call-end',
      'text',
      'turn-end',
    ]);
  });

  it('pins conversation_id directly from stream-json init over a concurrent cwd cache entry', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let cwdCache = 'concurrent-session-before';
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => cwdCache,
    });

    const t1 = backend.sendPrompt('/work', 'first');
    current.stdout.emit('data', '{"event":"init","conversation_id":"exact-stream-cid"}\n');
    cwdCache = 'concurrent-session-overwrote-cache';
    current.child.emit('close', 0);
    await t1;

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('exact-stream-cid');
  });

  it('flushes partial buffered output and redacts stderr secrets on non-zero exit', async () => {
    const { child, stdout, stderr } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const log = vi.fn();
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      log,
      resolveConversationId: () => null,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'long turn');
    stdout.emit(
      'data',
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'partial answer before timeout',
        },
      })}\n`,
    );
    stderr.emit(
      'data',
      '[agy] print timeout after 30m0s with turn in progress\nAuthorization: Bearer secret-stderr-token\n',
    );
    child.emit('close', 3);

    await expect(turn).rejects.toThrow(/print timeout after 30m0s/);
    expect(messages).toContainEqual({
      type: 'model-output',
      textDelta: 'partial answer before timeout',
    });
    expect(JSON.stringify(messages)).not.toContain('secret-stderr-token');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-stderr-token');
  });

  it('rejects when stream-json result status is ERROR even if exit code is 0', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit(
      'data',
      `${JSON.stringify({
        event: 'result',
        result: { status: 'ERROR', error: 'Quota exceeded for model' },
      })}\n`,
    );
    child.emit('close', 0);

    await expect(turn).rejects.toThrow('agy stream reported failure: Quota exceeded for model');
    expect(messages.at(-1)).toMatchObject({
      type: 'status',
      status: 'error',
      detail: 'agy stream reported failure: Quota exceeded for model',
    });
  });
});
