import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import { AgyAcpBackend, AgyCancelledError, type AgyAcpOptions } from './AgyAcpBackend';

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
    if (rpc.method === 'initialize') respond(rpc.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
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
  const backend = new AgyAcpBackend({ cwd: '/work', permissionMode: 'default', model: 'Gemini 3.8 Flash', effort: 'medium', spawnFn, ...options });
  backends.push(backend);
  const messages: AgentMessage[] = [];
  backend.onMessage(m => messages.push(m));
  return { agent, spawnFn, backend, messages };
}
afterEach(async () => { await Promise.all(backends.splice(0).map(b => b.dispose())); });

async function promptRequest(agent: ReturnType<typeof fakeAgent>) {
  await vi.waitFor(() => expect(agent.received.some(r => r.method === 'session/prompt')).toBe(true));
  return [...agent.received].reverse().find(r => r.method === 'session/prompt')!;
}

describe('persistent Antigravity ACP', () => {
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

  it.each(['completed', 'failed', 'unfinished'])('preserves tool %s state without forwarding raw output', async (status) => {
    const { backend, agent, messages } = setup();
    agent.setHandler((rpc, fallback) => {
      if (rpc.method !== 'session/prompt') return fallback(rpc);
      agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'false' } });
      if (status !== 'unfinished') agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status, rawOutput: 'secret=not-for-display' });
      agent.respond(rpc.id!, { stopReason: 'end_turn' });
    });
    await backend.sendPrompt('', 'run');
    const results = messages.filter(m => m.type === 'tool-result');
    expect(results).toEqual([{
      type: 'tool-result', callId: 'cmd', toolName: 'Bash', isError: status !== 'completed',
      result: status === 'completed' ? null : status === 'failed' ? 'Antigravity tool failed.' : 'Tool interrupted before completion.',
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

});
