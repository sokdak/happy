import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  const mockSession = {
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      handler({});
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    sendPromptError: null as Error | null,
    startSessionCalls: 0,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
  };

  return {
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockStartHappyServer: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy'),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    mockConsoleLog: vi.spyOn(console, 'log').mockImplementation(() => {}),
    sessionHandlers,
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    mockSession,
    backendState,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: mocks.mockReadSettings,
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: { host: 'host', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy' },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('./AcpBackend', () => ({
  AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
    }

    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      mocks.backendState.startSessionCalls += 1;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: 'acp-session-1' };
    }

    async sendPrompt(sessionId: string, prompt: string) {
      mocks.backendState.prompts.push({ sessionId, prompt });
      if (mocks.backendState.sendPromptError) {
        throw mocks.backendState.sendPromptError;
      }
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'running' });
        listener({ type: 'model-output', textDelta: 'hello' });
        listener({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
        listener({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
        listener({ type: 'status', status: 'idle' });
      }
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      return true;
    }

    async setSessionMode(modeId: string) {
      mocks.backendState.setModeCalls.push(modeId);
      return true;
    }

    async setSessionModel(modelId: string) {
      mocks.backendState.setModelCalls.push(modelId);
      return true;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'stopped' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runAcp } from './runAcp';
import type { AcpRunnerBackend } from './runAcp';
import type { AcpBackendOptions } from './AcpBackend';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.sendPromptError = null;
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.cancelCalls = [];
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
    mocks.mockStartHappyServer.mockResolvedValue({
      url: 'http://127.0.0.1:9876',
      stop: vi.fn(),
    });
    mocks.mockGetOrCreateSession.mockResolvedValue({ id: 'session-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 1, metadataVersion: 1, agentStateVersion: 1 } as any);
    mocks.mockSession.updateAgentState.mockImplementation(handler => { handler({}); });
  });

  function nativeHarness() {
    let emit: (message: any) => void = () => {};
    let options: AcpBackendOptions;
    const backend: AcpRunnerBackend = {
      onMessage: handler => { emit = handler; },
      startSession: vi.fn(async () => {
        emit({ type: 'event', name: 'config_options_update', payload: { configOptions: [
          { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'deepseek-flash', options: [{ value: 'deepseek-flash', name: 'Flash' }, { value: 'deepseek-v4-pro', name: 'Pro' }] },
          { type: 'select', id: 'reasoning_effort', name: 'Effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
          { type: 'select', id: 'happy_permission_mode', name: 'Permissions', category: 'mode', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }, { value: 'read-only', name: 'Read' }] },
        ] } });
        return { sessionId: 'native-dsh' };
      }),
      sendPrompt: vi.fn(async () => {}), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => true), setSessionMode: vi.fn(async () => true), setSessionModel: vi.fn(async () => true),
    };
    const run = (extra: Partial<Parameters<typeof runAcp>[0]> = {}) => runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'deepseek', command: 'dsh', args: [], responseCompletesTurn: true,
      recoverPromptErrors: true, preserveSessionOnExit: true, nativeSessionIdKey: 'deepseekSessionId',
      backendFactory: value => { options = value; return backend; }, ...extra,
    });
    return { backend, run, emit: (message: any) => emit(message), options: () => options! };
  }

  it('uses prompt responses to complete native turns, forwards selections and usage, and preserves the session', async () => {
    const native = nativeHarness();
    let finish!: () => void;
    vi.mocked(native.backend.sendPrompt).mockImplementation(async () => {
      native.emit({ type: 'status', status: 'running' });
      native.emit({ type: 'model-output', textDelta: '\nHello\n\n**world**\n' });
      native.emit({ type: 'event', name: 'context_usage', payload: { used: 123, size: 1048576 } });
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const running = native.run();
    await vi.waitFor(() => expect(native.backend.startSession).toHaveBeenCalled());
    mocks.getUserMessageHandler()!({ content: { text: 'go' }, meta: { model: 'deepseek-v4-pro', effort: 'max', permissionMode: 'read-only' } });
    await vi.waitFor(() => expect(mocks.mockSession.sendSessionProtocolMessage.mock.calls.some(([envelope]) => envelope.ev.t === 'text')).toBe(true));
    expect(native.backend.setSessionConfigOption).toHaveBeenCalledWith('model', 'deepseek-v4-pro');
    expect(native.backend.setSessionConfigOption).toHaveBeenCalledWith('reasoning_effort', 'max');
    expect(native.backend.setSessionConfigOption).toHaveBeenCalledWith('happy_permission_mode', 'read-only');
    const envelopes = () => mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([value]) => value);
    expect(envelopes().some(envelope => envelope.ev.t === 'turn-end')).toBe(false);
    expect(envelopes()).toContainEqual(expect.objectContaining({ ev: { t: 'text', text: '\nHello\n\n**world**\n' } }));
    expect(envelopes()).toContainEqual(expect.objectContaining({ usage: { input_tokens: 123, output_tokens: 0, context_window: 1048576 } }));
    expect(envelopes().find(envelope => envelope.usage)?.turn).toBeUndefined();
    finish();
    await vi.waitFor(() => expect(envelopes().some(envelope => envelope.ev.t === 'turn-end' && envelope.ev.status === 'completed')).toBe(true));
    expect(mocks.mockSession.keepAlive).toHaveBeenLastCalledWith(false, 'remote');
    expect(mocks.mockNotifyDaemonSessionStarted).toHaveBeenCalledWith('session-1', expect.objectContaining({ deepseekSessionId: 'native-dsh' }), expect.any(Object));
    await mocks.getKillHandler()!();
    await running;
    const finalMetadata = mocks.mockSession.updateMetadata.mock.calls.at(-1)![0]({});
    expect(finalMetadata).toMatchObject({ lifecycleState: 'running', archivedBy: undefined });
  });

  it('joins approval state to the native tool card and unblocks pending questions on abort', async () => {
    const native = nativeHarness();
    let state: any = {};
    mocks.mockSession.updateAgentState.mockImplementation(handler => { state = handler(state); });
    vi.mocked(native.backend.sendPrompt).mockImplementation(async () => {
      native.emit({ type: 'tool-call', callId: 'native-call', toolName: 'Write', args: { file_path: '/outside' } });
      await native.options().permissionHandler!.handleToolCall('native-call', 'Write', { file_path: '/outside' });
    });
    const running = native.run({ interactionTools: true });
    await vi.waitFor(() => expect(native.backend.startSession).toHaveBeenCalled());
    mocks.getUserMessageHandler()!({ content: { text: 'write' } });
    await vi.waitFor(() => expect(Object.keys(state.requests ?? {})).toHaveLength(1));
    const card = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([value]) => value.ev).find(event => event.t === 'tool-call-start');
    expect(Object.keys(state.requests)).toEqual([card.call]);
    await mocks.sessionHandlers.get('permission')!({ id: card.call, approved: true });
    await vi.waitFor(() => expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
    const interactions = mocks.mockStartHappyServer.mock.calls[0][1];
    await interactions.updatePlan([{ step: 'Verify result', status: 'in_progress' }]);
    const question = interactions.requestUserInput([{ id: 'q', header: 'Choice', question: 'Pick one', options: [{ label: 'A', description: 'First' }] }], new AbortController().signal);
    await vi.waitFor(() => expect(Object.keys(state.communications ?? {})).toHaveLength(1));
    await mocks.sessionHandlers.get('abort')!({});
    await expect(question).resolves.toEqual({ answers: {} });
    expect(state.communications).toEqual({});
    expect(mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([value]) => value.ev)).toContainEqual(expect.objectContaining({ t: 'tool-call-start', name: 'TodoWrite', args: { todos: [{ content: 'Verify result', status: 'in_progress', activeForm: 'Verify result' }] } }));
    await mocks.getKillHandler()!();
    await running;
  });

  it('keeps the queue usable after a failed turn and forwards image-only attachments', async () => {
    const native = nativeHarness();
    vi.mocked(native.backend.sendPrompt).mockRejectedValueOnce(new Error('provider failed'));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const input = mocks.mockSession as any;
    input.drainAttachmentsForUserMessage = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ data: png, mimeType: 'image/png', name: 'image.png' }]);
    const running = native.run();
    try {
      await vi.waitFor(() => expect(native.backend.startSession).toHaveBeenCalled());
      mocks.getUserMessageHandler()!({ content: { text: 'first' } });
      await vi.waitFor(() => expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
      mocks.getUserMessageHandler()!({ content: { text: '' } });
      await vi.waitFor(() => expect(native.backend.sendPrompt).toHaveBeenCalledTimes(2));
      expect(native.backend.sendPrompt).toHaveBeenLastCalledWith('native-dsh', '', [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    } finally {
      await mocks.getKillHandler()!();
      await running;
      delete input.drainAttachmentsForUserMessage;
    }
  });

  it('reuses the encrypted Happy reconnect identity without creating or replaying a session', async () => {
    const native = nativeHarness();
    const input = mocks.mockSession as any;
    input.skipExistingMessages = vi.fn();
    input.suppressNextArchiveSignal = vi.fn();
    const reconnect = { id: 'saved-happy', encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 42, metadataVersion: 3, agentStateVersion: 4 } as any;
    const running = native.run({ reconnect: () => reconnect });
    try {
      await vi.waitFor(() => expect(native.backend.startSession).toHaveBeenCalled());
      expect(mocks.mockGetOrCreateSession).not.toHaveBeenCalled();
      expect(mocks.mockSetupOfflineReconnection).toHaveBeenCalledWith(expect.objectContaining({ response: reconnect }));
      expect(input.skipExistingMessages).toHaveBeenCalledOnce();
      expect(input.suppressNextArchiveSignal).toHaveBeenCalledOnce();
    } finally {
      await mocks.getKillHandler()!();
      await running;
      delete input.skipExistingMessages;
      delete input.suppressNextArchiveSignal;
    }
  });

  it('wires backend messages through mapper into session envelopes', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Build a test plan' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('opencode');
    expect(mocks.backendState.constructorArgs.args).toEqual(['--acp']);
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: 'Build a test plan',
    });

    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Happy Session ID: session-1',
      'Incoming prompt: Build a test plan',
      'Status: running',
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
      'Tool: ReadFile completed (callId=tool-1)',
      'Status: idle',
    ]));
  });

  it('registers abort handler that cancels the ACP backend session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    expect(abortHandler).toBeTypeOf('function');

    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('emits thinking messages in default mode', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    const listener = mocks.backendState.listeners[0];
    const prompts = mocks.backendState.prompts;
    if (!listener) {
      throw new Error('Expected backend listener to be registered');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Think first' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    listener({ type: 'event', name: 'thinking', payload: { text: 'Analyzing request' } });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(prompts).toHaveLength(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Thinking: "Analyzing request"',
    ]));
  });

  it('emits raw backend and envelope logs when verbose is enabled', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run the command' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines.some((line) => line.startsWith('Outgoing raw backend message from opencode: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Incoming raw envelope for opencode: '))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
    ]));
  });

  it('logs slash commands, modes, and models line by line when verbose is enabled', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'available_commands',
        payload: [
          { name: 'init', description: 'create/update AGENTS.md' },
          { name: 'review', description: 'review uncommitted changes' },
        ],
      },
      {
        type: 'event',
        name: 'modes_update',
        payload: {
          availableModes: [
            { id: 'build', name: 'build', description: 'Executes tools' },
            { id: 'plan', name: 'plan', description: 'Disallows edit tools' },
          ],
          currentModeId: 'build',
        },
      },
      {
        type: 'event',
        name: 'models_update',
        payload: {
          currentModelId: 'gemini-2.5-pro',
          availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing slash commands from gemini (2):',
      '  /init - create/update AGENTS.md',
      '  /review - review uncommitted changes',
      'Outgoing modes from gemini (2), current=build:',
      '  mode=build name=build - Executes tools',
      '  mode=plan name=plan - Disallows edit tools',
      'Outgoing models from gemini (2), current=gemini-2.5-pro:',
      '  model=gemini-2.5-pro name=Gemini 2.5 Pro',
      '  model=gemini-2.5-flash name=Gemini 2.5 Flash',
    ]));
  });

  it('exits when backend reports terminal startup status', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'status', status: 'error', detail: 'spawn opencode ENOENT' },
    ];

    await runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    expect(consoleLines()).toContain('Status: error: spawn opencode ENOENT');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'opencode error: spawn opencode ENOENT',
    });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('surfaces a prompt exception when no backend error status was emitted', async () => {
    mocks.backendState.sendPromptError = new Error('model switch failed');
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });
    const runOutcome = runPromise.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Use that model' },
    });

    expect(await runOutcome).toMatchObject({ message: 'model switch failed' });
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'opencode error: model switch failed',
    });
  });

  it('updates session metadata with ACP config options (models and operating modes)', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'code',
              options: [
                { value: 'ask', name: 'Ask', description: 'Q&A mode' },
                { value: 'code', name: 'Code', description: 'Implementation mode' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
                { value: 'claude-opus', name: 'Claude Opus', description: 'Deep reasoning model' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const baseMetadata = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
    };
    const appliedMetadata = metadataHandlers.map((handler) => handler(baseMetadata));

    expect(appliedMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentModelCode: 'claude-sonnet',
          currentOperatingModeCode: 'code',
          models: [
            { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
            { code: 'claude-opus', value: 'Claude Opus', description: 'Deep reasoning model' },
          ],
          operatingModes: [
            { code: 'ask', value: 'Ask', description: 'Q&A mode' },
            { code: 'code', value: 'Code', description: 'Implementation mode' },
          ],
        }),
      ]),
    );
  });

  it('switches ACP model and permission mode when requested values match config options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Apply settings then run' },
      meta: {
        permissionMode: 'Code',
        model: 'claude-opus',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'permission-mode', value: 'code' },
      { configId: 'model', value: 'claude-opus' },
    ]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('ignores ACP model and permission mode requests when values do not match advertised options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without switching' },
      meta: {
        permissionMode: 'invalid-mode',
        model: 'invalid-model',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });
});
