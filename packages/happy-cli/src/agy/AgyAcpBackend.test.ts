import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import { AgyAcpBackend, AgyCancelledError, type AgyAcpOptions } from './AgyAcpBackend';
import { STOP_HOOK_LIMITS } from './stopHook';

const model = { modelId: 'flash-medium', name: 'Gemini 3.8 Flash (Medium)' };
const metadata = {
  models: { currentModelId: model.modelId, availableModels: [model, { modelId: 'flash-high', name: 'Gemini 3.8 Flash (High)' }] },
  modes: { currentModeId: 'default', availableModes: ['default', 'accept-edits', 'plan'].map(id => ({ id, name: id })) },
};
type Rpc = { id?: number; method?: string; params?: any; result?: any };
function fakeAgent() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as any;
  Object.assign(child, { stdout, stderr, pid: 12345, exitCode: null, signalCode: null });
  const received: Rpc[] = [];
  const respond = (id: number, result: unknown) => stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const notify = (update: unknown, sessionId = 'session-1') => stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) + '\n');
  let handler = (rpc: Rpc) => {
    if (rpc.id === undefined) return;
    if (rpc.method === 'initialize') respond(rpc.id, { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.9' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
    else if (rpc.method === 'session/new') respond(rpc.id, { sessionId: 'session-1', ...metadata });
    else if (rpc.method === 'session/load') respond(rpc.id, metadata);
    else if (rpc.method === 'session/prompt') respond(rpc.id, { stopReason: 'end_turn' });
    else if (rpc.method) respond(rpc.id, {});
  };
  let buffer = '';
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n'); const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const rpc = JSON.parse(line); received.push(rpc); handler(rpc);
    }
    callback();
  } });
  child.kill = vi.fn((signal = 'SIGTERM') => {
    if (child.signalCode) return false;
    child.signalCode = signal;
    child.emit('exit', null, signal);
    stdout.end(); child.stdin.end(); stderr.end();
    return true;
  });
  return { child, stdout, stderr, received, respond, notify,
    setHandler(fn: (rpc: Rpc, fallback: (rpc: Rpc) => void) => void) { const fallback = handler; handler = rpc => fn(rpc, fallback); },
  };
}
const backends: AgyAcpBackend[] = [];
function setup(options: Partial<AgyAcpOptions> = {}) {
  const agent = fakeAgent();
  const spawnFn = vi.fn(() => agent.child) as unknown as typeof spawn;
  const backend = new AgyAcpBackend({
    cwd: '/work', stopHook: false, stopHookLimits: { maxBackoffMs: 0 },
    permissionMode: 'default', model: 'Gemini 3.8 Flash', effort: 'medium', spawnFn, ...options,
  });
  backends.push(backend);
  const messages: AgentMessage[] = [];
  backend.onMessage(m => messages.push(m));
  return { agent, spawnFn, backend, messages };
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(backends.splice(0).map(b => b.dispose())); });

async function promptRequest(agent: ReturnType<typeof fakeAgent>) {
  await vi.waitFor(() => expect(agent.received.some(r => r.method === 'session/prompt')).toBe(true));
  return [...agent.received].reverse().find(r => r.method === 'session/prompt')!;
}

async function invokeStop(spawnFn: typeof spawn, executionNum: number, fullyIdle: boolean) {
  const workspace = vi.mocked(spawnFn).mock.calls.at(-1)![1]!.at(-1)!;
  const command = JSON.parse(readFileSync(join(workspace, '.agents/hooks.json'), 'utf8'))['happy-acp-background'].Stop[0].command;
  return new Promise<any>((resolve, reject) => {
    const p = execFile('/bin/sh', ['-c', command], (error, out) => error ? reject(error) : resolve(JSON.parse(out)));
    p.stdin!.end(JSON.stringify({ conversationId: 'session-1', hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', executionNum, fullyIdle, continuationActive: false }));
  });
}

describe('persistent Antigravity ACP', () => {
  describe.skipIf(process.platform === 'win32')('optional Stop hook', () => {
    it.each([
      ['Run manage_task', { name: 'manage_task', arguments: { Action: 'status', TaskId: 'session/task-12' } }],
      ['Run manage_task', { Action: 'status', TaskId: 'session/task-12' }],
      ['Run schedule', { DurationSeconds: 1, TimerCondition: 'session/task-12', Prompt: 'private scheduled prompt' }],
    ])('does not reset the stalled continuation budget for %s cards displayed as Bash (%j)', async (title, rawInput) => {
      const { backend, agent, spawnFn, messages } = setup({ stopHook: true });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'background');
      const rejected = expect(pending).rejects.toThrow('no completed tool progress');
      const request = await promptRequest(agent);
      const limit = STOP_HOOK_LIMITS.maxStalledContinuations;
      for (let i = 0; i <= limit; i++) {
        agent.notify({ sessionUpdate: 'tool_call', toolCallId: `status-${i}`, title, kind: 'other', status: 'in_progress', rawInput });
        agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: `status-${i}`, status: 'completed' });
        await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(i + 1));
        expect(await invokeStop(spawnFn, i, false)).toEqual(i < limit ? { decision: 'continue', reason: expect.any(String) } : {});
      }
      expect(messages.filter(m => m.type === 'tool-call').every(m => m.type === 'tool-call' && m.toolName === 'Bash')).toBe(true);
      agent.respond(request.id!, { stopReason: 'end_turn' }); await rejected;
    });
    it('keeps the stalled continuation budget after a failed action', async () => {
      const { backend, agent, spawnFn, messages } = setup({ stopHook: true, stopHookLimits: { maxBackoffMs: 0, maxStalledContinuations: 1 } });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'background');
      const request = await promptRequest(agent);
      expect((await invokeStop(spawnFn, 0, false)).decision).toBe('continue');
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit file', kind: 'edit', status: 'failed' });
      await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-result', isError: true })));
      const decision = await invokeStop(spawnFn, 1, false);
      agent.respond(request.id!, { stopReason: 'end_turn' });
      await expect(pending).rejects.toThrow('no completed tool progress');
      expect(decision).toEqual({});
    });
    it.each(['printf DONE', 'Run read_file', 'Run schedule'])('resets the stalled allowance after a real command finishes despite its title: %s', async (title) => {
      const { backend, agent, spawnFn, messages } = setup({ stopHook: true, stopHookLimits: { maxBackoffMs: 0, maxStalledContinuations: 4 } });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'background');
      const request = await promptRequest(agent);
      const limit = 4;
      for (let i = 0; i < limit; i++) expect((await invokeStop(spawnFn, i, false)).decision).toBe('continue');
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'command', title, kind: 'execute', status: 'completed', rawInput: { CommandLine: 'printf DONE' } });
      await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(1));
      expect(messages).toContainEqual({ type: 'tool-call', callId: 'command', toolName: 'Bash', args: { command: 'printf DONE' } });
      expect((await invokeStop(spawnFn, limit, false)).decision).toBe('continue');
      await invokeStop(spawnFn, limit + 1, true);
      agent.respond(request.id!, { stopReason: 'end_turn' }); await pending;
    });
    it('resets the stalled allowance on file edit and subagent delegation, but not on manage_subagents polling', async () => {
      const { backend, agent, spawnFn, messages } = setup({ stopHook: true, stopHookLimits: { maxBackoffMs: 0, maxStalledContinuations: 3 } });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'subagent-review');
      const request = await promptRequest(agent);
      for (let i = 0; i < 3; i++) {
        agent.notify({ sessionUpdate: 'tool_call', toolCallId: `sub-poll-${i}`, title: 'Run manage_subagents', kind: 'other', status: 'completed', rawInput: { Action: 'list' } });
        await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(i + 1));
        expect((await invokeStop(spawnFn, i, false)).decision).toBe('continue');
      }
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'edit_file', kind: 'edit', status: 'completed', rawInput: { Path: '/work/a.ts', Target: 'old', Replacement: 'new' } });
      await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(4));
      expect((await invokeStop(spawnFn, 3, false)).decision).toBe('continue');
      await invokeStop(spawnFn, 4, true);
      agent.respond(request.id!, { stopReason: 'end_turn' });
      await pending;
    });
    it('wakes Stop-hook backoff immediately when run_command finishes, ignoring status/schedule completions', async () => {
      const { backend, agent, spawnFn } = setup({
        stopHook: true,
        stopHookLimits: { initialBackoffMs: 2_000, maxBackoffMs: 2_000 },
      });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'background');
      const request = await promptRequest(agent);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg-cmd', title: 'npm install', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'npm install' } });
      const startedAt = Date.now();
      const hookCall = invokeStop(spawnFn, 0, false);
      let settled = false;
      void hookCall.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'poll-1', title: 'Run manage_task', kind: 'other', status: 'completed', rawInput: { Action: 'status', TaskId: 'session/task-1' } });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(settled).toBe(false);
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-cmd', status: 'completed' });
      expect((await hookCall).decision).toBe('continue');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await invokeStop(spawnFn, 1, true);
      agent.respond(request.id!, { stopReason: 'end_turn' });
      await pending;
    });
    it('keeps the prompt open across Stop continuation, tool completion and a final idle hook', async () => {
      const { backend, agent, spawnFn, messages } = setup({ stopHook: true });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'background');
      const request = await promptRequest(agent);
      const workspace = vi.mocked(spawnFn).mock.calls[0][1]!.at(-1)!;
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'sleep', kind: 'execute', status: 'in_progress' });
      expect((await invokeStop(spawnFn, 0, false)).decision).toBe('continue');
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed' });
      expect(await invokeStop(spawnFn, 1, true)).toEqual({});
      agent.respond(request.id!, { stopReason: 'end_turn' }); await pending;
      expect(messages.at(-1)).toEqual({ type: 'status', status: 'idle' });
      await backend.dispose(); expect(existsSync(workspace)).toBe(false);
    });
    it('fails visibly when the enabled hook is missing, then retires its process', async () => {
      const { backend, agent } = setup({ stopHook: true });
      await expect(backend.sendPrompt('', 'no hook')).rejects.toThrow('Stop hook did not report');
      expect(agent.child.kill).toHaveBeenCalled();
    });
    it.each([false, true])('reports rejection appropriately when a final idle hook is present: %s', async (idleHook) => {
      const { backend, agent, spawnFn } = setup({ stopHook: true, requestPermission: async () => ({ decision: 'denied' }) });
      agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
      const pending = backend.sendPrompt('', 'denied');
      const result = idleHook ? pending : expect(pending).rejects.toThrow('permission was denied');
      const request = await promptRequest(agent);
      agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 960, method: 'session/request_permission', params: {
        sessionId: 'session-1', toolCall: { toolCallId: 'deny', title: 'Command', kind: 'execute' },
        options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }],
      } }) + '\n');
      await vi.waitFor(() => expect(agent.received.find(r => r.id === 960)?.result).toBeDefined());
      if (idleHook) await invokeStop(spawnFn, 0, true);
      agent.respond(request.id!, { stopReason: 'end_turn' }); await result;
      expect(agent.received.filter(r => r.method === 'session/prompt')).toHaveLength(1);
    });
    it.each(['1.5.9', '1.5.10', '1.5.11'])('accepts verified server version %s when Stop hook is enabled', async (version) => {
      const { backend, agent, spawnFn } = setup({ stopHook: true });
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') agent.respond(rpc.id!, { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
        else if (rpc.method !== 'session/prompt') fallback(rpc);
      });
      const pending = backend.sendPrompt('', 'verified');
      const request = await promptRequest(agent);
      await invokeStop(spawnFn, 0, true);
      agent.respond(request.id!, { stopReason: 'end_turn' });
      await pending;
    });
    it('uses native completion on an unknown server in auto mode without creating sessions or prompting twice', async () => {
      vi.stubEnv('HAPPY_AGY_STOP_HOOK', undefined);
      const { backend, agent, spawnFn } = setup({ stopHook: undefined, resumeSessionId: 'saved-session' });
      const clean = fakeAgent();
      vi.mocked(spawnFn).mockReturnValueOnce(agent.child).mockReturnValueOnce(clean.child);
      for (const server of [agent, clean]) server.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') server.respond(rpc.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
        else fallback(rpc);
      });
      await backend.sendPrompt('', 'only once');
      expect(agent.received.map(r => r.method)).toEqual(['initialize']);
      expect(agent.child.kill).toHaveBeenCalled();
      expect(vi.mocked(spawnFn).mock.calls[1][1]).toEqual(['acp', '--add-dir', '/work']);
      expect(clean.received.filter(r => r.method === 'session/load').map(r => r.params.sessionId)).toEqual(['saved-session']);
      expect(clean.received.filter(r => r.method === 'session/prompt')).toHaveLength(1);
    });
    it('rejects an unverified server version before sending a prompt', async () => {
      const { backend, agent } = setup({ stopHook: true });
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') agent.respond(rpc.id!, { protocolVersion: 1, agentInfo: { name: 'Antigravity', version: '9.0.0' } });
        else fallback(rpc);
      });
      await expect(backend.sendPrompt('', 'version')).rejects.toThrow('verified only');
      expect(agent.received.some(r => r.method === 'session/prompt')).toBe(false);
    });
    it('retires the hook process on cancellation and loads the same session with a new private root', async () => {
      const second = fakeAgent();
      const { backend, agent, spawnFn } = setup({ stopHook: true });
      vi.mocked(spawnFn).mockReturnValueOnce(agent.child).mockReturnValueOnce(second.child);
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'session/cancel') agent.respond(agent.received.find(r => r.method === 'session/prompt')!.id!, { stopReason: 'cancelled' });
        else if (rpc.method !== 'session/prompt') fallback(rpc);
      });
      const pending = backend.sendPrompt('', 'cancel'); const rejected = expect(pending).rejects.toBeInstanceOf(AgyCancelledError);
      await promptRequest(agent);
      const oldRoot = vi.mocked(spawnFn).mock.calls[0][1]!.at(-1)!;
      await backend.cancel(); await rejected;
      expect(agent.child.kill).toHaveBeenCalled(); expect(existsSync(oldRoot)).toBe(false);
      await backend.startSession();
      expect(second.received.find(r => r.method === 'session/load')?.params.sessionId).toBe('session-1');
      expect(vi.mocked(spawnFn).mock.calls[1][1]!.at(-1)).not.toBe(oldRoot);
    });
  });

  it.each([undefined, 'saved-session'])('passes Happy MCP on new/load and title instructions only on the first successful turn (%s)', async (resumeSessionId) => {
    const mcpServers = [{ name: 'happy', command: '/node', args: ['/bridge', '--url', 'http://127.0.0.1:1234'], env: [] }];
    const { backend, agent } = setup({ resumeSessionId, mcpServers, initialPrompt: 'Use change_title at start and on topic changes.' });
    await backend.startSession();
    expect(agent.received.find(r => r.method === (resumeSessionId ? 'session/load' : 'session/new'))?.params.mcpServers).toEqual(mcpServers);
    await backend.sendPrompt('', 'first');
    await backend.sendPrompt('', 'second');
    const prompts = agent.received.filter(r => r.method === 'session/prompt');
    expect(prompts[0].params.prompt[0].text).toContain('change_title');
    expect(prompts[0].params.prompt[0].text).toContain('first');
    expect(prompts[1].params.prompt[0].text).toBe('second');
  });

  it('reuses the exact server session and process across turns without print flags or cache lookup', async () => {
    const { backend, spawnFn, agent } = setup();
    expect(await backend.startSession()).toEqual({ sessionId: 'session-1' });
    await backend.sendPrompt('ignored', 'first');
    await backend.sendPrompt('ignored', 'second');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnFn).mock.calls[0][1]).toEqual(['acp', '--add-dir', '/work']);
    expect(agent.received.filter(r => r.method === 'session/prompt').map(r => r.params.sessionId)).toEqual(['session-1', 'session-1']);
    expect(agent.received.filter(r => r.method === 'session/new')).toHaveLength(1);
    expect(agent.received.some(r => r.method === 'session/set_config_option')).toBe(false);
  });

  it('streams text, thought and native tool lifecycle while the prompt remains in progress', async () => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'read');
    const request = await promptRequest(agent);
    agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking...' } });
    agent.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning' } });
    agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'read_file', kind: 'read', status: 'in_progress', rawInput: { Path: '/work/a' } });
    agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'password=private' });
    agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' });
    await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(1));
    expect(messages).toContainEqual({ type: 'model-output', textDelta: 'Checking...' });
    expect(messages).toContainEqual({ type: 'event', name: 'thinking', payload: { text: 'Planning', streaming: true } });
    expect(messages).toContainEqual({ type: 'tool-call', callId: 'read-1', toolName: 'Read', args: { file_path: '/work/a' } });
    expect(JSON.stringify(messages)).not.toContain('private');
    expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);
    agent.respond(request.id!, { stopReason: 'end_turn' });
    await turn;
  });

  it.each([
    [{ query: 'controller manual' }, 'WebSearch', { query: 'controller manual' }],
    [{ Query: 'controller', SearchPath: '/work' }, 'Grep', { pattern: 'controller', path: '/work' }],
    [{ Pattern: '*.ts', SearchDirectory: '/work' }, 'Glob', { pattern: '*.ts', path: '/work' }],
    [{ name: 'search_web', args: { query: 'manual' } }, 'WebSearch', { query: 'manual' }],
    [{}, 'search', {}],
  ])('maps native search arguments without guessing from generic kind (%j)', async (rawInput, toolName, args) => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => {
      if (rpc.method !== 'session/prompt') return fallback(rpc);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'search', title: 'Search', kind: 'search', status: 'in_progress', rawInput });
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'search', status: 'completed' });
      agent.respond(rpc.id!, { stopReason: 'end_turn' });
    });
    await backend.sendPrompt('', 'search');
    expect(messages).toContainEqual({ type: 'tool-call', callId: 'search', toolName, args });
  });

  it.each([
    ['Run manage_task', { Action: 'status', TaskId: 'session/task-12' }, 'Bash', { command: 'manage_task status task-12' }],
    ['Run schedule', { DurationSeconds: 10, TimerCondition: 'session/task-12', Prompt: 'private scheduled prompt' }, 'Bash', { command: 'schedule 10s for task-12' }],
    ['Run ask_question', { questions: [{ question: 'Which branch to merge?', options: ['main', 'develop'] }] }, 'Bash', { command: 'ask_question "Which branch to merge?" (main, develop)' }],
    ['Run send_message', { Recipient: 'session/worker-1', Message: 'private-secret' }, 'Bash', { command: 'send_message to worker-1' }],
    ['Run define_subagent', { Name: 'helper', Description: 'private-desc', SystemPrompt: 'private-prompt' }, 'Bash', { command: 'define_subagent helper' }],
    ['Run command_status', { CommandId: 'private-id' }, 'Bash', { command: 'command_status' }],
    ['Run list_dir', { DirectoryPath: '/work' }, 'LS', { path: '/work' }],
    ['Run made_up_tool', { password: 'private-value' }, 'other', {}],
    ['Run schedule extra text', { Prompt: 'private-value' }, 'other', {}],
    ['Human title secret=private-value', {}, 'other', {}],
    ['Run mcp_happy_change_title', {}, 'other', {}],
    ['Run manage_task', { name: 'read_file', Path: '/work/file' }, 'Read', { file_path: '/work/file' }],
  ])('preserves known native labels and safe arguments: %s', async (title, rawInput, toolName, args) => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => {
      if (rpc.method !== 'session/prompt') return fallback(rpc);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'native', title, kind: 'other', status: 'in_progress', rawInput });
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'native', status: 'completed' });
      agent.respond(rpc.id!, { stopReason: 'end_turn' });
    });
    await backend.sendPrompt('', 'fixture');
    expect(messages).toContainEqual({ type: 'tool-call', callId: 'native', toolName, args });
    expect(JSON.stringify(messages)).not.toContain('private');
  });

  it.each([
    ['other', 'Run manage_task', { Action: 'kill', TaskId: 'session/task-12' }, 'manage_task kill task-12'],
    ['execute', 'Run read_file', { CommandLine: 'printf HI' }, 'printf HI'],
  ] as const)('passes %s permissions without allowing titles to downgrade execution, and honors denial once', async (kind, title, rawInput, command) => {
    const requestPermission = vi.fn(async () => ({ decision: 'denied' as const }));
    const { backend, agent } = setup({ requestPermission });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'fixture');
    const request = await promptRequest(agent);
    agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 800, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'task', title, kind, rawInput },
      options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }],
    } }) + '\n');
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(requestPermission).toHaveBeenCalledWith('task', 'Bash', { command });
    await vi.waitFor(() => expect(agent.received.find(r => r.id === 800)?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } }));
    agent.respond(request.id!, { stopReason: 'end_turn' }); await turn;
  });

  it.each(['completed', 'failed', 'unfinished'])('preserves tool %s state without forwarding raw output', async (status) => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => {
      if (rpc.method !== 'session/prompt') return fallback(rpc);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'false' } });
      if (status !== 'unfinished') agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status, rawOutput: 'secret=not-for-display' });
      agent.respond(rpc.id!, { stopReason: 'end_turn' });
    });
    const turn = backend.sendPrompt('', 'run');
    if (status === 'unfinished') {
      await expect(turn).rejects.toThrow('completion is unconfirmed');
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);
    } else await turn;
    const results = messages.filter(m => m.type === 'tool-result');
    expect(results).toEqual([{
      type: 'tool-result', callId: 'cmd', toolName: 'Bash', isError: status !== 'completed',
      result: status === 'completed' ? null : status === 'failed' ? 'Antigravity tool failed.' : 'Completion was not reported. Background work may still be running.',
    }]);
    expect(JSON.stringify(messages)).not.toContain('not-for-display');
  });

  it('does not turn control deadlines or a pause between chunks into prompt timeouts', async () => {
    const { backend, agent } = setup({ requestTimeoutMs: 30 });
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/prompt') setTimeout(() => agent.respond(rpc.id!, { stopReason: 'end_turn' }), 100);
      else fallback(rpc);
    });
    await backend.sendPrompt('', 'longer than control timeout');
  });

  it('loads an explicit session, suppressing replayed history', async () => {
    const { backend, agent, messages } = setup({ resumeSessionId: 'saved-session' });
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/load') agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } }, 'saved-session');
      fallback(rpc);
    });
    expect(await backend.startSession()).toEqual({ sessionId: 'saved-session' });
    await backend.sendPrompt('', 'new');
    expect(agent.received.some(r => r.method === 'session/new')).toBe(false);
    expect(agent.received.find(r => r.method === 'session/load')?.params.sessionId).toBe('saved-session');
    expect(JSON.stringify(messages)).not.toContain('OLD HISTORY');
  });

  it('selects model and mode using typed string requests on the existing session', async () => {
    const { backend, agent } = setup();
    await backend.sendPrompt('', 'first');
    backend.setEffort('high'); backend.setPermissionMode('acceptEdits');
    await backend.sendPrompt('', 'second');
    expect(agent.received.filter(r => r.method === 'session/set_model').map(r => r.params.modelId)).toEqual(['flash-medium', 'flash-high']);
    expect(agent.received.filter(r => r.method === 'session/set_mode').map(r => r.params.modeId)).toEqual(['default', 'accept-edits']);
  });

  it('rejects unavailable models before sending a prompt', async () => {
    const { backend, agent } = setup({ model: 'missing' });
    await expect(backend.sendPrompt('', 'do work')).rejects.toThrow('model is unavailable');
    expect(agent.received.some(r => r.method === 'session/prompt')).toBe(false);
  });

  it('sends image content through ACP alongside text', async () => {
    const { backend, agent } = setup();
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw==' };
    await backend.sendPrompt('', 'describe', [image]);
    expect(agent.received.find(r => r.method === 'session/prompt')?.params.prompt).toEqual([{ type: 'text', text: 'describe' }, image]);
  });

  it('cancels a turn without killing a cooperative server and reuses it on the next turn', async () => {
    const { backend, agent, spawnFn } = setup();
    let pending: number | undefined;
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/prompt') pending = rpc.id;
      else if (rpc.method === 'session/cancel') agent.respond(pending!, { stopReason: 'cancelled' });
      else fallback(rpc);
    });
    const turn = backend.sendPrompt('', 'wait');
    const rejected = expect(turn).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent);
    await backend.cancel(); await rejected;
    agent.setHandler((rpc, fallback) => { if (rpc.method === 'session/prompt') agent.respond(rpc.id!, { stopReason: 'end_turn' }); else fallback(rpc); });
    await backend.sendPrompt('', 'next');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(agent.child.kill).not.toHaveBeenCalled();
  });

  it('kills a server ignoring cancel after a bounded grace period', async () => {
    const { backend, agent } = setup({ cancelGraceMs: 20 });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt' && rpc.method !== 'session/cancel') fallback(rpc); });
    const turn = backend.sendPrompt('', 'wait');
    const rejected = expect(turn).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent);
    await backend.cancel(); await rejected;
    expect(agent.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('drains cancellation before a queued prompt even when child exit is delayed', async () => {
    const second = fakeAgent();
    const { backend, agent, spawnFn } = setup({ cancelGraceMs: 20 });
    vi.mocked(spawnFn).mockReturnValueOnce(agent.child).mockReturnValueOnce(second.child);
    const kill = agent.child.kill.getMockImplementation();
    agent.child.kill.mockImplementation((signal: string) => { setTimeout(() => kill(signal), 200); return true; });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt' && rpc.method !== 'session/cancel') fallback(rpc); });
    const initial = backend.sendPrompt('', 'first'); const rejected = expect(initial).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent);
    const cancelling = backend.cancel();
    const next = backend.sendPrompt('', 'next');
    await cancelling; await rejected; await next;
    expect(agent.child.signalCode).toBeNull();
    expect(second.received.find(r => r.method === 'session/load')?.params.sessionId).toBe('session-1');
  });

  it('holds a newly queued prompt until cancellation finishes and rejects late permission approval', async () => {
    let approve!: (value: { decision: 'approved' }) => void;
    const { backend, agent } = setup({ requestPermission: () => new Promise(resolve => { approve = resolve; }) });
    let first: Rpc | undefined;
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/prompt' && !first) first = rpc;
      else if (rpc.method === 'session/cancel') setTimeout(() => agent.respond(first!.id!, { stopReason: 'cancelled' }), 30);
      else fallback(rpc);
    });
    const initial = backend.sendPrompt('', 'first'); const rejected = expect(initial).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent);
    agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 970, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'late', title: 'Command' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    } }) + '\n');
    await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    const cancelled = backend.cancel();
    const next = backend.sendPrompt('', 'next');
    approve({ decision: 'approved' });
    expect(agent.received.filter(r => r.method === 'session/prompt')).toHaveLength(1);
    await cancelled; await rejected; await next;
    expect(agent.received.find(r => r.id === 970)?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(agent.received.filter(r => r.method === 'session/prompt')).toHaveLength(2);
  });

  it('fails a disconnected turn, then reloads the same session without replaying the failed prompt', async () => {
    const second = fakeAgent();
    const { backend, agent, spawnFn } = setup();
    vi.mocked(spawnFn).mockReturnValueOnce(agent.child).mockReturnValueOnce(second.child);
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'first');
    const rejected = expect(turn).rejects.toThrow(/exited|closed/i);
    await promptRequest(agent); agent.child.kill(); await rejected;
    await backend.sendPrompt('', 'second');
    expect(second.received.find(r => r.method === 'session/load')?.params.sessionId).toBe('session-1');
    expect(second.received.filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['second']);
  });

  it('times out startup and cleans up the child', async () => {
    const { backend, agent } = setup({ requestTimeoutMs: 20 });
    agent.setHandler(() => {});
    await expect(backend.startSession()).rejects.toThrow('timed out');
    expect(agent.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('prevents concurrent turns and ignores notifications for other sessions', async () => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'wait');
    const request = await promptRequest(agent);
    await expect(backend.sendPrompt('', 'overlap')).rejects.toThrow('already running');
    agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong session' } }, 'other');
    agent.respond(request.id!, { stopReason: 'end_turn' }); await turn;
    expect(JSON.stringify(messages)).not.toContain('wrong session');
  });
  it.each([
    ['default', undefined, 'reject'],
    ['default', 'approved', 'allow'],
    ['default', 'denied', 'reject'],
    ['yolo', undefined, 'allow'],
    ['bypassPermissions', undefined, 'allow'],
    ['safe-yolo', 'denied', 'reject'],
  ] as const)('handles %s permission with decision %s without granting sticky approvals', async (mode, decision, optionId) => {
    const handler = vi.fn(async () => ({ decision: decision ?? 'denied' }));
    const { backend, agent } = setup({ permissionMode: mode, requestPermission: decision ? handler : undefined });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'permission');
    const prompt = await promptRequest(agent);
    agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'command-1', title: 'Execute command', kind: 'execute', rawInput: { CommandLine: 'echo test' } },
      options: [{ optionId: 'sticky', name: 'Always', kind: 'allow_always' }, { optionId: 'allow', name: 'Once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    } }) + '\n');
    await vi.waitFor(() => expect(agent.received.find(r => r.id === 900)?.result).toEqual({ outcome: { outcome: 'selected', optionId } }));
    agent.respond(prompt.id!, { stopReason: 'end_turn' }); await turn;
  });

  it.each([
    [true, 'Run mcp_happy_change_title', 'mcp__happy__change_title'],
    [true, 'Run mcp_happy_change_title_and_run_command', 'other'],
    [false, 'Run mcp_happy_change_title', 'other'],
  ] as const)('maps the exact native title label only with the Happy server configured (%s, %s)', async (configured, title, expectedName) => {
    const requestPermission = vi.fn(async () => ({ decision: 'approved' as const }));
    const { backend, agent } = setup({ requestPermission, mcpServers: configured ? [{ name: 'happy', command: '/node', args: [], env: [] }] : [] });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'title');
    const prompt = await promptRequest(agent);
    agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 950, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'title-1', title, kind: 'other', rawInput: { title: 'Test title' } },
      options: [{ optionId: 'allow', name: 'Once', kind: 'allow_once' }],
    } }) + '\n');
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledWith('title-1', expectedName, expect.anything()));
    agent.respond(prompt.id!, { stopReason: 'end_turn' }); await turn;
  });

  it('cancels a pending permission request and clears its UI state', async () => {
    const resetPermissions = vi.fn();
    const { backend, agent } = setup({ requestPermission: () => new Promise(() => {}), resetPermissions });
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/cancel') {
        const pending = agent.received.find(r => r.method === 'session/prompt')!;
        agent.respond(pending.id!, { stopReason: 'cancelled' });
      } else if (rpc.method !== 'session/prompt') fallback(rpc);
    });
    const turn = backend.sendPrompt('', 'permission');
    const rejected = expect(turn).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent);
    agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'pending-1', title: 'Command' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    await backend.cancel(); await rejected;
    await vi.waitFor(() => expect(agent.received.find(r => r.id === 901)?.result).toEqual({ outcome: { outcome: 'cancelled' } }));
    expect(resetPermissions).toHaveBeenCalled();
  });

  it('fails closed when the server cannot load the exact saved conversation', async () => {
    const { backend, agent } = setup({ resumeSessionId: 'unavailable' });
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'session/load') agent.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Session not found' } }) + '\n');
      else fallback(rpc);
    });
    await expect(backend.sendPrompt('', 'new action')).rejects.toThrow('Session not found');
    expect(agent.received.some(r => r.method === 'session/new' || r.method === 'session/prompt')).toBe(false);
  });

  it('rejects images before prompting a server without that capability', async () => {
    const { backend, agent } = setup();
    agent.setHandler((rpc, fallback) => {
      if (rpc.method === 'initialize') agent.respond(rpc.id!, { protocolVersion: 1, agentCapabilities: {} });
      else fallback(rpc);
    });
    await expect(backend.sendPrompt('', 'image', [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }])).rejects.toThrow('image input');
    expect(agent.received.some(r => r.method === 'session/prompt')).toBe(false);
  });

  it('disposes an active turn and prohibits future reconnects', async () => {
    const { backend, agent } = setup();
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'wait');
    const rejected = expect(turn).rejects.toBeInstanceOf(AgyCancelledError);
    await promptRequest(agent); await backend.dispose(); await rejected;
    await expect(backend.startSession()).rejects.toThrow('disposed');
  });

  it('survives spawn failure without leaking raw errors or hanging disposal', async () => {
    const agent = fakeAgent(); agent.child.pid = undefined;
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => { agent.child.emit('error', new Error('password=private')); agent.stdout.end(); agent.child.emit('close'); });
      return agent.child;
    }) as unknown as typeof spawn;
    const { backend, messages } = setup({ spawnFn });
    await expect(backend.sendPrompt('', 'start')).rejects.toThrow('Could not start');
    await backend.dispose();
    expect(JSON.stringify(messages)).not.toContain('private');
  });

  it('escalates shutdown for a process that ignores SIGTERM', async () => {
    const { backend, agent } = setup();
    const original = agent.child.kill.getMockImplementation();
    agent.child.kill.mockImplementation((signal: string) => signal === 'SIGTERM' ? true : original(signal));
    await backend.startSession();
    await backend.dispose();
    expect(agent.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(agent.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('maps ACP diff content blocks for Edit and Write (including late tool_call_update diffs) with credential redaction', async () => {
    const requestPermission = vi.fn(async () => ({ decision: 'approved' as const }));
    const { backend, agent, messages } = setup({ requestPermission });
    agent.setHandler((rpc, fallback) => { if (rpc.method !== 'session/prompt') fallback(rpc); });
    const turn = backend.sendPrompt('', 'edit files');
    const prompt = await promptRequest(agent);

    // 1) Permission request carrying an ACP diff block for a new file (oldText: null -> Write)
    agent.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 980,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'write-1',
          title: 'Create file',
          kind: 'edit',
          rawInput: {},
          content: [{ type: 'diff', path: '/work/new.ts', oldText: null, newText: 'export const x = 1;\napi_key=secret_val' }],
        },
        options: [{ optionId: 'allow', name: 'Once', kind: 'allow_once' }],
      },
    }) + '\n');
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledWith('write-1', 'Write', {
      file_path: '/work/new.ts',
      content: 'export const x = 1;\n[redacted]',
    }));

    // 2) Initial tool_call with empty placeholder strings followed by tool_call_update carrying an Edit diff block
    agent.notify({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit app.ts',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { Path: '/work/app.ts', Target: '', Replacement: '' },
    });
    agent.notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      rawInput: { Target: undefined },
      content: [{ type: 'diff', path: '/work/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;\ntoken=private_tok' }],
    });

    await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(1));
    expect(messages).toContainEqual({
      type: 'tool-call',
      callId: 'edit-1',
      toolName: 'Edit',
      args: {
        file_path: '/work/app.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;\n[redacted]',
      },
    });
    expect(JSON.stringify(messages)).not.toContain('secret_val');
    expect(JSON.stringify(messages)).not.toContain('private_tok');

    agent.respond(prompt.id!, { stopReason: 'end_turn' });
    await turn;
  });

  describe('AGY 1.5.10 post-end_turn session follow-ups (without Stop hook)', () => {
    function setup1510(options: Partial<AgyAcpOptions> = {}) {
      const ctx = setup({ stopHook: false, ...options });
      ctx.agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          ctx.agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
        } else fallback(rpc);
      });
      return ctx;
    }

    it('keeps background tools open across initial end_turn, approves late permissions, and flushes final output without claiming idle', async () => {
      const requestPermission = vi.fn(async (_id: string, tool: string, input: any) => ({
        decision: tool === 'Bash' && (input.command === 'python3 bg.py' || input.command === 'python3 followup.py')
          ? 'approved' as const : 'denied' as const,
      }));
      const { backend, agent, messages } = setup1510({ requestPermission });
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
          return;
        }
        if (rpc.method !== 'session/prompt') return fallback(rpc);
        agent.notify({
          sessionUpdate: 'tool_call',
          toolCallId: 'bg-1',
          title: 'python3 bg.py',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { CommandLine: 'python3 bg.py' },
        });
        agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING_INITIAL' } });
        agent.respond(rpc.id!, { stopReason: 'end_turn' });
      });

      await expect(backend.sendPrompt('', 'run background')).rejects.toThrow('completion is unconfirmed');
      // Foreground ended, but bg-1 must NOT be prematurely closed with a fake error on 1.5.10.
      expect(messages.filter(m => m.type === 'tool-result')).toHaveLength(0);
      expect(messages).toContainEqual({ type: 'event', name: 'agy_step_complete', payload: null });

      // Background task finishes and triggers reactive wakeup + late permission + final text.
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-1', status: 'completed' });
      agent.notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'followup-1',
        title: 'python3 followup.py',
        kind: 'execute',
        status: 'pending',
        rawInput: { CommandLine: 'python3 followup.py' },
      });
      agent.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 701,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'followup-1', title: 'python3 followup.py', kind: 'execute', rawInput: { CommandLine: 'python3 followup.py' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        },
      }) + '\n');

      await vi.waitFor(() => expect(agent.received.find(r => r.id === 701)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }));
      expect(requestPermission).toHaveBeenCalledWith('followup-1', 'Bash', { command: 'python3 followup.py' });

      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'followup-1', status: 'completed' });
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nFINAL_VISIBLE' } });
      agent.notify({ sessionUpdate: 'usage_update', used: 100, size: 1000 } as any);

      await vi.waitFor(() => expect(messages.filter(m => m.type === 'event' && m.name === 'agy_step_complete')).toHaveLength(2));
      expect(messages.filter(m => m.type === 'tool-result')).toEqual([
        { type: 'tool-result', callId: 'bg-1', toolName: 'Bash', result: null, isError: false },
        { type: 'tool-result', callId: 'followup-1', toolName: 'Bash', result: null, isError: false },
      ]);
      expect(messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toBe('WAITING_INITIAL\n\nFINAL_VISIBLE');
      // Without an observer Stop hook, ACP v1 alone must never fabricate overall idle completion.
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);
    });

    it('honors late permission denial after end_turn without auto-cancelling', async () => {
      const requestPermission = vi.fn(async () => ({ decision: 'denied' as const }));
      const { backend, agent, messages } = setup1510({ requestPermission });
      await backend.sendPrompt('', 'initial sync finish');

      agent.notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'late-deny',
        title: 'rm -rf something',
        kind: 'execute',
        status: 'pending',
        rawInput: { CommandLine: 'rm -rf something' },
      });
      agent.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 702,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'late-deny', title: 'rm -rf something', kind: 'execute', rawInput: { CommandLine: 'rm -rf something' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        },
      }) + '\n');

      await vi.waitFor(() => expect(agent.received.find(r => r.id === 702)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      }));
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'late-deny', status: 'failed' });
      await vi.waitFor(() => expect(messages).toContainEqual({
        type: 'tool-result',
        callId: 'late-deny',
        toolName: 'Bash',
        result: 'Antigravity tool failed.',
        isError: true,
      }));
    });

    it('preserves original tool ownership without duplicating cards when a new prompt overlaps running background work', async () => {
      const { backend, agent, messages } = setup1510();
      let promptCount = 0;
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
          return;
        }
        if (rpc.method !== 'session/prompt') return fallback(rpc);
        promptCount++;
        if (promptCount === 1) {
          agent.notify({
            sessionUpdate: 'tool_call',
            toolCallId: 'bg-overlap',
            title: 'python3 bg.py',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { CommandLine: 'python3 bg.py' },
          });
          agent.respond(rpc.id!, { stopReason: 'end_turn' });
        } else {
          // Second prompt finishes synchronously while bg-overlap from turn 1 is still running!
          agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECOND_OK' } });
          agent.respond(rpc.id!, { stopReason: 'end_turn' });
        }
      });

      await expect(backend.sendPrompt('', 'first')).rejects.toThrow('completion is unconfirmed');
      // Second prompt succeeds cleanly because IT left no unresolved tools of its own!
      await backend.sendPrompt('', 'second');

      // Now bg-overlap from first prompt completes: must emit tool-result once without a duplicate tool-call!
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-overlap', status: 'completed' });
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-overlap', status: 'completed' });
      await vi.waitFor(() => expect(messages.filter(m => m.type === 'tool-result' && m.callId === 'bg-overlap')).toHaveLength(1));
      expect(messages.filter(m => m.type === 'tool-call' && m.callId === 'bg-overlap')).toHaveLength(1);
    });

    it('sends session/cancel after end_turn, cancels pending late permissions, fences late events, and reuses cooperative server', async () => {
      let resolvePerm!: (value: { decision: 'approved' }) => void;
      const resetPermissions = vi.fn();
      const { backend, agent, spawnFn, messages } = setup1510({
        resetPermissions,
        requestPermission: () => new Promise(resolve => { resolvePerm = resolve; }),
      });
      let promptCount = 0;
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
          return;
        }
        if (rpc.method === 'session/cancel') {
          agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-cancel', status: 'failed' });
          return;
        }
        if (rpc.method !== 'session/prompt') return fallback(rpc);
        promptCount++;
        if (promptCount === 1) {
          agent.notify({
            sessionUpdate: 'tool_call',
            toolCallId: 'bg-cancel',
            title: 'sleep 30',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { CommandLine: 'sleep 30' },
          });
          agent.respond(rpc.id!, { stopReason: 'end_turn' });
        } else {
          agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECOVERED_NEXT' } });
          agent.respond(rpc.id!, { stopReason: 'end_turn' });
        }
      });

      await expect(backend.sendPrompt('', 'start bg')).rejects.toThrow('completion is unconfirmed');
      agent.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 703,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'late-perm', title: 'echo late', kind: 'execute', rawInput: { CommandLine: 'echo late' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }) + '\n');
      await vi.waitFor(() => expect(resolvePerm).toBeTypeOf('function'));

      await backend.cancel();
      resolvePerm({ decision: 'approved' });
      expect(agent.received.some(r => r.method === 'session/cancel')).toBe(true);
      await vi.waitFor(() => expect(agent.received.find(r => r.id === 703)?.result).toEqual({ outcome: { outcome: 'cancelled' } }));
      expect(resetPermissions).toHaveBeenCalled();

      // Any stale post-cancel event must be dropped completely.
      const countAfterCancel = messages.length;
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_AFTER_CANCEL' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(messages.length).toBe(countAfterCancel);

      // Next turn reuses the cooperative 1.5.10 server cleanly.
      await backend.sendPrompt('', 'next after cancel');
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(messages).toContainEqual({ type: 'model-output', textDelta: 'RECOVERED_NEXT' });
    });

    it('settles IsDaemon=true tools cleanly at end_turn without blocking completion or duplicating later exits', async () => {
      const { backend, agent, messages } = setup1510();
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
          return;
        }
        if (rpc.method !== 'session/prompt') return fallback(rpc);
        agent.notify({
          sessionUpdate: 'tool_call',
          toolCallId: 'daemon-1',
          title: 'npm run dev',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { CommandLine: 'npm run dev', IsDaemon: true },
        });
        agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Dev server started.' } });
        agent.respond(rpc.id!, { stopReason: 'end_turn' });
      });

      await backend.sendPrompt('', 'start dev server');
      expect(messages).toContainEqual({
        type: 'tool-result',
        callId: 'daemon-1',
        toolName: 'Bash',
        result: 'Background daemon continues running.',
        isError: false,
      });
      expect(messages.at(-1)).toEqual({ type: 'status', status: 'idle' });

      // Late daemon termination does not create a duplicate tool card.
      const before = messages.length;
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'daemon-1', status: 'completed' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(messages.length).toBe(before);
    });

    it('does not enable post-end_turn session updates on unverified versions (1.5.9 or 1.6.0)', async () => {
      for (const version of ['1.5.9', '1.6.0']) {
        const { backend, agent, messages } = setup({ stopHook: false });
        agent.setHandler((rpc, fallback) => {
          if (rpc.method === 'initialize') {
            agent.respond(rpc.id!, {
              protocolVersion: 1,
              agentInfo: { name: 'Antigravity ACP Server', version },
              agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
            });
          } else fallback(rpc);
        });
        await backend.sendPrompt('', 'sync');
        agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNVERIFIED_LATE' } });
        agent.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 704,
          method: 'session/request_permission',
          params: {
            sessionId: 'session-1',
            toolCall: { toolCallId: 'u-1', title: 'cmd', kind: 'execute' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        }) + '\n');
        await vi.waitFor(() => expect(agent.received.find(r => r.id === 704)?.result).toEqual({ outcome: { outcome: 'cancelled' } }));
        expect(JSON.stringify(messages)).not.toContain('UNVERIFIED_LATE');
      }
    });
  });

  describe.skipIf(process.platform === 'win32')('AGY 1.5.10 observer Stop hook (zero forced continuations)', () => {
    function setupObserver1510(options: Partial<AgyAcpOptions> = {}) {
      const ctx = setup({ stopHook: true, observerSettleMs: 10, permissionDenialSettleMs: 50, ...options });
      ctx.agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          ctx.agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
        } else if (rpc.method !== 'session/prompt') fallback(rpc);
      });
      return ctx;
    }

    it('keeps a single turn open across staggered reactive wakeups and late permissions without forcing continue', async () => {
      const logs: string[] = [];
      const requestPermission = vi.fn(async (_id: string, tool: string, input: any) => ({
        decision: tool === 'Bash' && ['python3 bg1.py', 'python3 bg2.py', 'python3 followup.py'].includes(input.command)
          ? 'approved' as const : 'denied' as const,
      }));
      const { backend, agent, spawnFn, messages } = setupObserver1510({
        log: m => logs.push(m),
        requestPermission,
      });

      const pending = backend.sendPrompt('', 'parallel background');
      const req = await promptRequest(agent);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg-1', title: 'bg1', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'python3 bg1.py' } });
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg-2', title: 'bg2', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'python3 bg2.py' } });
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING_INITIAL' } });

      // Foreground Stop reports fullyIdle=false -> hook returns {} (NOT continue!)
      expect(await invokeStop(spawnFn, 0, false)).toEqual({});
      agent.respond(req.id!, { stopReason: 'end_turn' });
      await vi.waitFor(() => expect(messages.filter(m => m.type === 'event' && m.name === 'agy_step_complete')).toHaveLength(1));
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);

      // bg-1 completes -> intermediate wakeup -> Stop(executionNum=0, fullyIdle=false) -> still open!
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-1', status: 'completed' });
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nBG1_SEEN' } });
      expect(await invokeStop(spawnFn, 0, false)).toEqual({});
      await vi.waitFor(() => expect(messages.filter(m => m.type === 'event' && m.name === 'agy_step_complete')).toHaveLength(2));
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);

      // bg-2 completes -> followup requests permission -> final answer -> Stop(executionNum=0, fullyIdle=true)!
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-2', status: 'completed' });
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'followup-1', title: 'followup', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'python3 followup.py' } });
      agent.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 801,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'followup-1', title: 'followup', kind: 'execute', rawInput: { CommandLine: 'python3 followup.py' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }) + '\n');
      await vi.waitFor(() => expect(agent.received.find(r => r.id === 801)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }));
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'followup-1', status: 'completed' });
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nFINAL_VISIBLE' } });
      expect(await invokeStop(spawnFn, 0, true)).toEqual({});

      await pending;
      expect(agent.received.filter(r => r.method === 'session/prompt')).toHaveLength(1);
      expect(messages.at(-1)).toEqual({ type: 'status', status: 'idle' });
      expect(logs.some(l => l.includes('0 continuations, mode=observe, observations=3, idle=true'))).toBe(true);
    });

    it('fails deterministically without hanging when a late wakeup permission is denied and AGY skips Stop', async () => {
      const requestPermission = vi.fn(async (_id: string, _tool: string, input: any) => ({
        decision: input.command === 'python3 bg1.py' ? 'approved' as const : 'denied' as const,
      }));
      const { backend, agent, spawnFn } = setupObserver1510({ requestPermission, permissionDenialSettleMs: 40 });
      const pending = backend.sendPrompt('', 'deny late');
      const rejected = expect(pending).rejects.toThrow('permission was denied');
      const req = await promptRequest(agent);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg-1', title: 'bg1', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'python3 bg1.py' } });
      await invokeStop(spawnFn, 0, false);
      agent.respond(req.id!, { stopReason: 'end_turn' });

      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-1', status: 'completed' });
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'followup-deny', title: 'followup', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'python3 denied.py' } });
      agent.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 802,
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { toolCallId: 'followup-deny', title: 'followup', kind: 'execute', rawInput: { CommandLine: 'python3 denied.py' } },
          options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        },
      }) + '\n');
      await vi.waitFor(() => expect(agent.received.find(r => r.id === 802)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'deny' },
      }));
      agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'followup-deny', status: 'failed' });
      await rejected;
    });

    it('cancels during observer background wait, drains failed tool update, fences late events, and reuses cooperative server', async () => {
      const { backend, agent, spawnFn, messages } = setupObserver1510();
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
        } else if (rpc.method === 'session/cancel') {
          agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-cancel', status: 'failed' });
        } else if (rpc.method !== 'session/prompt') fallback(rpc);
      });

      const pending = backend.sendPrompt('', 'cancel in observer wait');
      const rejected = expect(pending).rejects.toBeInstanceOf(AgyCancelledError);
      const req = await promptRequest(agent);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'bg-cancel', title: 'sleep 20', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 20' } });
      await invokeStop(spawnFn, 0, false);
      agent.respond(req.id!, { stopReason: 'end_turn' });

      await new Promise(resolve => setTimeout(resolve, 15));
      await backend.cancel();
      await rejected;
      expect(agent.received.some(r => r.method === 'session/cancel')).toBe(true);
      expect(agent.child.kill).not.toHaveBeenCalled();

      const countAfterCancel = messages.length;
      agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_AFTER_CANCEL' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(messages.length).toBe(countAfterCancel);

      // Subsequent prompt reuses the same cooperative process
      const next = backend.sendPrompt('', 'next turn');
      const req2 = await vi.waitFor(() => {
        const prompts = agent.received.filter(r => r.method === 'session/prompt');
        expect(prompts).toHaveLength(2);
        return prompts[1];
      });
      await invokeStop(spawnFn, 0, true);
      agent.respond(req2.id!, { stopReason: 'end_turn' });
      await next;
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('bounds unconfirmed non-daemon watchers in observer mode, retires wedged server, and recovers cleanly on next turn', async () => {
      const agent1 = fakeAgent();
      const agent2 = fakeAgent();
      for (const a of [agent1, agent2]) {
        a.setHandler((rpc, fallback) => {
          if (rpc.method === 'initialize') {
            a.respond(rpc.id!, {
              protocolVersion: 1,
              agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
              agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
            });
          } else if (rpc.method !== 'session/prompt') fallback(rpc);
        });
      }
      let calls = 0;
      const spawnFn = vi.fn(() => (++calls === 1 ? agent1.child : agent2.child)) as unknown as typeof spawn;
      const { backend, messages } = setup({
        stopHook: true,
        observerSettleMs: 10,
        stopHookLimits: { maxContinuationMs: 60 },
        spawnFn,
      });

      const pending = backend.sendPrompt('', 'stuck watcher');
      const rejected = expect(pending).rejects.toThrow('time limit reached');
      const req = await promptRequest(agent1);
      agent1.notify({ sessionUpdate: 'tool_call', toolCallId: 'watcher-1', title: 'sleep 999', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'sleep 999' } });
      await invokeStop(spawnFn, 0, false);
      agent1.respond(req.id!, { stopReason: 'end_turn' });

      await rejected;
      expect(messages.some(m => m.type === 'status' && m.status === 'idle')).toBe(false);
      expect(agent1.child.kill).toHaveBeenCalledWith('SIGTERM');

      // Turn 2 reloads the saved session on a fresh ACP server without hanging on Turn 1's stuck watcher
      const turn2 = backend.sendPrompt('', 'after watcher timeout');
      const req2 = await promptRequest(agent2);
      expect(agent2.received.some(r => r.method === 'session/load' && r.params?.sessionId === 'session-1')).toBe(true);
      agent2.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RECOVERED_CLEANLY' } });
      await invokeStop(spawnFn, 0, true);
      agent2.respond(req2.id!, { stopReason: 'end_turn' });
      await turn2;
      expect(messages.at(-1)).toEqual({ type: 'status', status: 'idle' });
    });

    it('reuses cooperative server on foreground cancel before Stop runs and preserves idle server on pre-prompt config error', async () => {
      const { backend, agent, spawnFn } = setupObserver1510();
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
          });
        } else if (rpc.method === 'session/cancel') {
          const pendingReq = [...agent.received].reverse().find(r => r.method === 'session/prompt');
          if (pendingReq?.id !== undefined) agent.respond(pendingReq.id, { stopReason: 'cancelled' });
        } else if (rpc.method !== 'session/prompt') fallback(rpc);
      });

      // Pre-prompt image capability error does not kill the healthy idle server
      await expect(backend.sendPrompt('', 'img', [{ type: 'image', data: 'aa==', mimeType: 'image/png' } as any]))
        .rejects.toThrow('does not support image input');
      expect(agent.child.kill).not.toHaveBeenCalled();

      // Foreground cancel before Stop hook runs reuses the cooperative server
      const p1 = backend.sendPrompt('', 'foreground cancel');
      const r1 = expect(p1).rejects.toBeInstanceOf(AgyCancelledError);
      await promptRequest(agent);
      await backend.cancel();
      await r1;
      expect(agent.child.kill).not.toHaveBeenCalled();

      const p2 = backend.sendPrompt('', 'follow-up after foreground cancel');
      const req2 = await vi.waitFor(() => {
        const prompts = agent.received.filter(r => r.method === 'session/prompt');
        expect(prompts).toHaveLength(2);
        return prompts[1];
      });
      await invokeStop(spawnFn, 0, true);
      agent.respond(req2.id!, { stopReason: 'end_turn' });
      await p2;
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('rejects explicit stopHook="observe" on AGY 1.5.9 before prompting', async () => {
      const { backend, agent } = setup({ stopHook: 'observe' });
      await expect(backend.sendPrompt('', 'version check')).rejects.toThrow('verified only with AGY 1.5.10');
      expect(agent.received.some(r => r.method === 'session/prompt')).toBe(false);
    });

    it.each(['1.5.10', '1.5.11'])('auto-selects observer mode on AGY %s when HAPPY_AGY_STOP_HOOK is unset', async (version) => {
      vi.stubEnv('HAPPY_AGY_STOP_HOOK', undefined);
      const logs: string[] = [];
      const { backend, agent, spawnFn } = setup({ stopHook: undefined, observerSettleMs: 10, log: m => logs.push(m) });
      agent.setHandler((rpc, fallback) => {
        if (rpc.method === 'initialize') {
          agent.respond(rpc.id!, {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          });
        } else if (rpc.method !== 'session/prompt') fallback(rpc);
      });
      const pending = backend.sendPrompt('', 'default auto observer');
      const req = await promptRequest(agent);
      expect(await invokeStop(spawnFn, 0, false)).toEqual({});
      agent.respond(req.id!, { stopReason: 'end_turn' });
      expect(await invokeStop(spawnFn, 0, true)).toEqual({});
      await pending;
      expect(logs.some(l => l.includes('0 continuations, mode=observe'))).toBe(true);
    });
  });

});
