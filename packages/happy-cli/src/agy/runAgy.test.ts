import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineSessionStub, transferOfflineRegistrations } from '@/utils/offlineSessionStub';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import type { SessionEvent } from '@slopus/happy-wire';

const fixture = vi.hoisted(() => {
  const listeners = new Set<(m: any) => void>();
  const calls: any[] = [];
  const rpc = new Map<string, (...args: any[]) => any>();
  const session: any = {
    rpcHandlerManager: { registerHandler: vi.fn((name, handler) => rpc.set(name, handler)) },
    sendSessionProtocolMessage: vi.fn(), sendSessionEvent: vi.fn(), keepAlive: vi.fn(),
    skipExistingMessages: vi.fn(), suppressNextArchiveSignal: vi.fn(),
    updateMetadata: vi.fn(), updateAgentState: vi.fn(), sendSessionDeath: vi.fn(), flush: vi.fn(), close: vi.fn(),
    onUserMessage: vi.fn((fn) => { session.user = fn; }),
    onFileEvent: vi.fn((fn) => { session.file = fn; }),
    pending: [] as Promise<any>[],
    trackAttachmentDownload: vi.fn((p) => session.pending.push(p)),
    drainAttachmentsForUserMessage: vi.fn(() => {
      const pending = session.pending; session.pending = []; return Promise.all(pending);
    }),
    downloadAndDecryptAttachment: vi.fn(),
    kill: undefined as undefined | (() => Promise<void>),
  };
  class FakeBackend {
    mode = 'default'; model = ''; effort = '';
    startSession = vi.fn(async () => ({ sessionId: 'acp-fixture' }));
    sendPrompt = vi.fn(async (_id: string, text: string, images: any[]) => {
      calls.push({ text, images, mode: this.mode, model: this.model, effort: this.effort });
      for (const fn of listeners) fn({ type: 'model-output', textDelta: 'Working' });
    });
    setPermissionMode(mode: string) { this.mode = mode; }
    setModel(model: string) { this.model = model; }
    setEffort(effort: string) { this.effort = effort; }
    onMessage(fn: (m: any) => void) { listeners.add(fn); }
    offMessage(fn: (m: any) => void) { listeners.delete(fn); }
    cancel = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
  }
  return { createSession: vi.fn(async () => null), session, calls, rpc, listeners, reconnectResponse: undefined as any, initialSession: undefined as any, swap: undefined as any, backend: new FakeBackend(), FakeBackend };
});
vi.mock('./happyMcp', () => ({ AGY_TITLE_INSTRUCTION: 'title instruction', startAgyHappyMcp: vi.fn(async () => ({ mcpServers: [], stop: vi.fn() })) }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({ getOrCreateMachine: vi.fn(), getOrCreateSession: fixture.createSession }) } }));
vi.mock('@/persistence', () => ({ readSettings: async () => ({ machineId: 'fixture' }) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/utils/createSessionMetadata', () => ({ createSessionMetadata: () => ({ state: {}, metadata: {} }) }));
vi.mock('@/utils/setupOfflineReconnection', () => ({ setupOfflineReconnection: ({ onSessionSwap, response }: any) => { fixture.reconnectResponse = response; fixture.swap = onSessionSwap; return { session: fixture.initialSession ?? fixture.session }; } }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn() }));
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: (_s: any, fn: any) => { fixture.session.kill = fn; } }));
vi.mock('./AgyAcpBackend', () => ({ AgyAcpBackend: fixture.FakeBackend, AgyCancelledError: class extends Error {} }));
vi.mock('./createBackend', () => ({ createAgyBackend: vi.fn(() => fixture.backend) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/AgyDisplay', () => ({ AgyDisplay: () => null }));
vi.mock('@/utils/serverConnectionErrors', () => ({ connectionState: { setBackend: vi.fn() } }));
import { runAgy } from './runAgy';
import { startAgyHappyMcp } from './happyMcp';
import { createAgyBackend } from './createBackend';

let running: Promise<void> | undefined;
async function begin(options: Partial<Parameters<typeof runAgy>[0]> = {}) {
  running = runAgy({ credentials: {} as any, ...options });
  await vi.waitFor(() => expect(fixture.session.kill).toBeTypeOf('function'));
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.calls.length = 0; fixture.session.pending = []; fixture.session.kill = undefined; fixture.rpc.clear(); fixture.initialSession = undefined; fixture.swap = undefined;
});
afterEach(async () => { await fixture.session.kill?.(); await running; expect(fixture.backend.dispose).toHaveBeenCalled(); running = undefined; vi.unstubAllEnvs(); });

function user(text: string, meta: Record<string, unknown> = {}) {
  fixture.session.user({ role: 'user', content: { type: 'text', text }, meta });
}

describe('Antigravity Happy runner integration', () => {
  it('reattaches to the existing encrypted Happy session without creating or replaying messages', async () => {
    vi.stubEnv('HAPPY_AGY_RECONNECT_METADATA', JSON.stringify({ flavor: 'agy', agySessionId: 'existing-agy', summary: { text: 'Keep title' } }));
    const values = { SESSION_ID: 'existing-happy', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ENCRYPTION_VARIANT: 'dataKey', SEQ: '42', METADATA_VERSION: '3', AGENT_STATE_VERSION: '4' };
    for (const [key, value] of Object.entries(values)) vi.stubEnv(`HAPPY_RECONNECT_${key}`, value);
    await begin({ resumeSessionId: 'existing-agy', model: 'Gemini 4 Carbon', permissionMode: 'plan' });
    expect(fixture.createSession).not.toHaveBeenCalled();
    expect(fixture.reconnectResponse).toMatchObject({ id: 'existing-happy', metadata: { summary: { text: 'Keep title' } }, seq: 42, metadataVersion: 3, agentStateVersion: 4 });
    expect(fixture.session.skipExistingMessages).toHaveBeenCalledTimes(1);
    expect(fixture.session.suppressNextArchiveSignal).toHaveBeenCalledTimes(1);
    expect(createAgyBackend).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'existing-agy', model: 'Gemini 4 Carbon', permissionMode: 'plan' }));
    expect(fixture.calls).toHaveLength(0);
    user('continue');
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0]).toMatchObject({ text: 'continue', model: 'Gemini 4 Carbon', mode: 'plan' });
  });

  it('connects title MCP and instructions and stops its server on shutdown', async () => {
    await begin();
    expect(startAgyHappyMcp).toHaveBeenCalledTimes(1);
    expect(createAgyBackend).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [], initialPrompt: 'title instruction' }));
    const server = await vi.mocked(startAgyHappyMcp).mock.results[0].value;
    await fixture.session.kill(); await running;
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps FIFO order, per-message images, and model/permission snapshots while downloads overlap', async () => {
    await begin();
    let complete!: (data: Uint8Array) => void;
    fixture.session.downloadAndDecryptAttachment.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    fixture.session.file({ content: { data: { ev: { ref: 'blob', name: 'image', size: 8, mimeType: 'image/jpeg' } } } });
    user('first with image', { model: 'Gemini 4 Argon', effort: 'high', permissionMode: 'acceptEdits' });
    user('second without image', { model: 'Gemini 4 Carbon', effort: 'low', permissionMode: 'default' });
    expect(fixture.calls).toHaveLength(0);
    complete(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(2));
    expect(fixture.calls[0]).toMatchObject({ text: 'first with image', mode: 'acceptEdits', model: 'Gemini 4 Argon', effort: 'high', images: [{ type: 'image', mimeType: 'image/png' }] });
    expect(fixture.calls[1]).toMatchObject({ text: 'second without image', mode: 'default', model: 'Gemini 4 Carbon', effort: 'low', images: [] });
    expect(fixture.session.sendSessionProtocolMessage.mock.calls.map(([e]: [any]) => e.ev.t).filter((t: string) => t === 'turn-end')).toHaveLength(2);
  });

  it('reports failed attachments without running an incomplete prompt or blocking the next message', async () => {
    await begin();
    fixture.session.downloadAndDecryptAttachment.mockRejectedValueOnce(new Error('fixture failure'));
    fixture.session.file({ content: { data: { ev: { ref: 'blob', name: 'image', size: 8 } } } });
    user('with failed image');
    user('next message');
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0].text).toBe('next message');
    expect(fixture.session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: expect.stringContaining('attachment') }));
  });

  it('keeps Markdown intact across slow chunks and flushes before tools and at completion', async () => {
    await begin();
    let finish!: () => void;
    fixture.backend.sendPrompt.mockImplementationOnce(async () => {
      for (const fn of fixture.listeners) fn({ type: 'model-output', textDelta: '\n**Still' } satisfies AgentMessage);
      await new Promise(resolve => setTimeout(resolve, 600));
      for (const fn of fixture.listeners) fn({ type: 'model-output', textDelta: ' working**\n' } satisfies AgentMessage);
      for (const fn of fixture.listeners) fn({ type: 'tool-call', callId: 'read', toolName: 'Read', args: { file_path: '/work/a' } } satisfies AgentMessage);
      for (const fn of fixture.listeners) fn({ type: 'model-output', textDelta: '```ts\nconst answer = ' } satisfies AgentMessage);
      await new Promise<void>(resolve => { finish = resolve; });
      for (const fn of fixture.listeners) fn({ type: 'model-output', textDelta: '42;\n```\n' } satisfies AgentMessage);
    });
    user('long turn');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { timeout: 2000 });
    const before: SessionEvent[] = fixture.session.sendSessionProtocolMessage.mock.calls.map(([e]: [any]) => e.ev);
    expect(before.filter(e => e.t === 'text')).toEqual([{ t: 'text', text: '\n**Still working**\n' }]);
    expect(before.at(-1)?.t).toBe('tool-call-start');
    finish();
    await vi.waitFor(() => expect(fixture.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
    const after: SessionEvent[] = fixture.session.sendSessionProtocolMessage.mock.calls.map(([e]: [any]) => e.ev);
    expect(after.filter(e => e.t === 'text')).toEqual([
      { t: 'text', text: '\n**Still working**\n' },
      { t: 'text', text: '```ts\nconst answer = 42;\n```\n' },
    ]);
    expect(after.at(-1)?.t).toBe('turn-end');
  });
  it('starts offline and routes messages transferred during reconnection through the real session', async () => {
    const stub = createOfflineSessionStub('fixture');
    fixture.initialSession = stub;
    await begin();
    // Transfer can synchronously deliver pending messages before onSessionSwap.
    fixture.session.onUserMessage.mockImplementationOnce((fn: any) => {
      fixture.session.user = fn;
      fn({ role: 'user', content: { type: 'text', text: 'received during reconnect' } });
    });
    transferOfflineRegistrations(stub, fixture.session);
    fixture.swap(fixture.session);
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
    expect(fixture.calls[0].text).toBe('received during reconnect');
  });

  it.each([true, false])('preserves the native session ID when ACP becomes ready before reconnection: %s', async (readyBeforeReconnect) => {
    fixture.initialSession = createOfflineSessionStub('fixture');
    await begin();
    const nativeReady = () => {
      for (const fn of fixture.listeners) fn({ type: 'event', name: 'agy_session_id', payload: 'native-offline' });
    };
    if (readyBeforeReconnect) nativeReady();
    fixture.swap(fixture.session);
    if (!readyBeforeReconnect) nativeReady();
    const updates = fixture.session.updateMetadata.mock.calls.map(([update]: [any]) => update({ summary: { text: 'Keep title' } }));
    expect(updates).toContainEqual({ agySessionId: 'native-offline', summary: { text: 'Keep title' } });
    user('continue after reconnection');
    await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
  });

});
