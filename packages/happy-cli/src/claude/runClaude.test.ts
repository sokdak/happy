import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartHappyServer: vi.fn(),
    mockStartHookServer: vi.fn(),
    mockRegisterKillSessionHandler: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mockApiClientCreate,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: mockReadSettings,
}));

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/claude/loop', () => ({
    loop: mockLoop,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mockNotifyDaemonSessionStarted,
}));

vi.mock('@/daemon/run', () => ({
    initialMachineMetadata: {},
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/happy-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: mockRegisterKillSessionHandler,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: {
        setBackend: vi.fn(),
        notifyOffline: vi.fn(),
        fail: vi.fn(),
    },
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));

import { runClaude } from './runClaude';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function expectPromptRejectsFast(promise: Promise<unknown>, pattern: RegExp) {
    await expect(Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('goal action did not reject')), 10);
        }),
    ])).rejects.toThrow(pattern);
}

async function startRemoteRunClaudeHarness(opts: {
    metadata?: Record<string, unknown>;
    updateAgentState?: ReturnType<typeof vi.fn>;
    registerHandler?: ReturnType<typeof vi.fn>;
    resetClaudeWorkflows?: ReturnType<typeof vi.fn>;
    flush?: ReturnType<typeof vi.fn>;
    close?: ReturnType<typeof vi.fn>;
} = {}) {
    let metadata = opts.metadata ?? {
        claudeSessionId: 'claude-session-1',
        slashCommands: ['goal'],
    };
    const updateAgentState = opts.updateAgentState ?? vi.fn();
    const registerHandler = opts.registerHandler ?? vi.fn();
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
        }),
        sendClaudeSessionMessage: vi.fn(),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => metadata),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: {
            registerHandler,
        },
        sendSessionDeath: vi.fn(),
        resetClaudeWorkflows: opts.resetClaudeWorkflows ?? vi.fn(async () => {}),
        flush: opts.flush ?? vi.fn(async () => {}),
        close: opts.close ?? vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    const runPromise = runClaude({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any, {
        startingMode: 'remote',
        shouldStartDaemon: false,
    });

    await vi.waitFor(() => {
        expect(mockCreateSessionScanner).toHaveBeenCalled();
        expect(mockLoop).toHaveBeenCalled();
    });

    const scannerOptions = mockCreateSessionScanner.mock.calls.at(-1)?.[0];
    const loopOptions = mockLoop.mock.calls.at(-1)?.[0];
    if (!scannerOptions || !loopOptions) {
        throw new Error('runClaude harness did not start');
    }
    const runtimeSession = { thinking: false, cleanup: vi.fn() };
    loopOptions.onSessionReady(runtimeSession);
    const goalActionHandler = registerHandler.mock.calls.find(([method]) => method === 'goal-action')?.[1];
    const happyServer = await mockStartHappyServer.mock.results.at(-1)?.value;
    const hookServer = await mockStartHookServer.mock.results.at(-1)?.value;
    const remoteScanner = await mockCreateSessionScanner.mock.results.at(-1)?.value;

    const finish = async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        loopDeferred.resolve(0);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    };

    const finishAfterCleanup = async () => {
        loopDeferred.resolve(0);
        await expect(runPromise).resolves.toBeUndefined();
    };

    return {
        api,
        finish,
        finishAfterCleanup,
        goalActionHandler,
        happyServer,
        hookServer,
        loopOptions,
        registerHandler,
        remoteScanner,
        resolveLoop: (exitCode: number) => loopDeferred.resolve(exitCode),
        runPromise,
        runtimeSession,
        scannerOptions,
        sessionClient,
        updateAgentState,
    };
}

function emitClaudeGoalStatus(
    scannerOptions: { onTranscriptEvent: (event: unknown) => void },
    event: {
        uuid: string;
        met: boolean;
        condition: string;
        sourceSessionId?: string;
    },
) {
    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: event.uuid,
        sourceRevision: event.uuid,
        sourceSessionId: event.sourceSessionId ?? 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: event.met,
            sentinel: true,
            condition: event.condition,
        },
    });
}

describe('runClaude remote JSONL scanner', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }

        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        delete process.env.HAPPY_FORKED_FROM_SESSION_ID;
        delete process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title'],
            stop: vi.fn(),
        });
        mockStartHookServer.mockResolvedValue({
            port: 23456,
            stop: vi.fn(),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(),
        });
    });

    afterEach(() => {
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) {
                process.on(event as any, listener);
            }
        }
        originalListeners.clear();
    });

    it('does not forward terminal JSONL messages while local mode owns the transcript', async () => {
        const sentMessages: unknown[] = [];
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'local-owned-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in local terminal',
            },
        });

        expect(sentMessages).toHaveLength(0);

        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onModeChange('remote');
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'remote-terminal-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in parallel remote terminal',
            },
        });

        expect(sentMessages).toHaveLength(1);
        expect(sessionClient.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'remote-terminal-user' }),
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('observes goal_status side-channel events as agent goal state', async () => {
        const sentMessages: unknown[] = [];
        let metadata = {
            claudeSessionId: 'claude-session-1',
            slashCommands: ['goal'],
        };
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn((updater: (current: typeof metadata) => typeof metadata) => {
                metadata = updater(metadata);
            }),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => metadata),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        expect(scannerOptions.onTranscriptEvent).toEqual(expect.any(Function));

        scannerOptions.onMessage({
            type: 'attachment',
            uuid: 'goal-event-as-message',
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });
        expect(sentMessages).toHaveLength(0);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-ignored',
            sourceSessionId: 'other-claude-session',
            sourceRevision: 'rev-ignored',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Wrong session goal',
            },
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        const userMessageHandler = sessionClient.onUserMessage.mock.calls[0][0];
        await userMessageHandler({
            content: { text: '/goal Ship goal observation' },
            meta: {},
        });
        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(1);

        scannerOptions.onTranscriptEvent({
            type: 'goal_status',
            uuid: 'goal-event-1',
            sourceSessionId: 'claude-session-1',
            sourceRevision: 'rev-1',
            timestamp: new Date().toISOString(),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: 'Ship goal observation',
            },
        });

        expect(sessionClient.updateAgentState).toHaveBeenCalledTimes(2);
        const goalUpdater = sessionClient.updateAgentState.mock.calls[1][0];
        const nextState = goalUpdater({ controlledByUser: false });
        expect(nextState).toMatchObject({
            controlledByUser: false,
            agentGoalStatus: {
                source: 'claude',
                status: 'active',
                sourceSessionId: 'claude-session-1',
                sourceRevision: 'rev-1',
                text: 'Ship goal observation',
                capabilities: { clear: true, edit: true },
            },
        });

        expect(sentMessages).toHaveLength(0);

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('registers Claude goal-action and queues clear as an isolated command without optimistic state changes', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'finish rpc test',
        });
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        const promise = handler({ action: 'clear' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal clear', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-cleared',
            met: true,
            condition: 'finish rpc test',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('rejects a second Claude goal action while one is pending', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        const first = handler({ action: 'edit', objective: 'new rpc goal' });
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        await expect(handler({ action: 'clear' })).rejects.toThrow(/already in progress|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
        ]);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-edited',
            met: false,
            condition: 'new rpc goal',
        });

        await expect(first).resolves.toEqual({ ok: true });
        await harness.finish();
    });

    it('times out a pending Claude goal action, resets pending, and allows a subsequent action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-timeout',
            met: false,
            condition: 'timeout rpc goal',
        });

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const first = handler({ action: 'clear' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal clear', isolate: true }),
            ]);

            vi.advanceTimersByTime(30000);
            await expect(first).rejects.toThrow(/Timed out waiting for Claude goal confirmation/);

            await harness.loopOptions.messageQueue.waitForMessagesAndGetAsString();
            const second = handler({ action: 'edit', objective: 'goal after timeout' });
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after timeout', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-timeout',
                met: false,
                condition: 'goal after timeout',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            vi.useRealTimers();
            await harness.finish();
        }
    });

    it('resets pending and clears timeout when pushIsolated throwing rejects Claude goal-action', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-push-failure',
            met: false,
            condition: 'push failure rpc goal',
        });

        const originalPushIsolated = harness.loopOptions.messageQueue.pushIsolated.bind(harness.loopOptions.messageQueue);
        const pushError = new Error('pushIsolated failed');
        const pushIsolatedSpy = vi.spyOn(harness.loopOptions.messageQueue, 'pushIsolated')
            .mockImplementationOnce(() => {
                throw pushError;
            })
            .mockImplementation((...args: unknown[]) => {
                const [message, mode, attachments] = args as [string, any, any];
                originalPushIsolated(message, mode, attachments);
            });
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        try {
            await expect(handler({ action: 'clear' })).rejects.toThrow(/pushIsolated failed/);
            expect(clearTimeoutSpy).toHaveBeenCalled();

            const second = handler({ action: 'edit', objective: 'goal after push failure' });
            expect(pushIsolatedSpy).toHaveBeenCalledTimes(2);
            expect(harness.loopOptions.messageQueue.queue).toEqual([
                expect.objectContaining({ message: '/goal goal after push failure', isolate: true }),
            ]);

            emitClaudeGoalStatus(harness.scannerOptions, {
                uuid: 'goal-att-after-push-failure',
                met: false,
                condition: 'goal after push failure',
            });
            await expect(second).resolves.toEqual({ ok: true });
        } finally {
            pushIsolatedSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            await harness.finish();
        }
    });

    it('queues edit Claude goal as isolated command and resolves only after a matching active side-channel status', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active',
            met: false,
            condition: 'old rpc goal',
        });

        let settled = false;
        const promise = handler({ action: 'edit', objective: '  revised rpc goal  ' });
        promise.then(() => { settled = true; });

        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: '/goal revised rpc goal', isolate: true }),
        ]);
        expect(harness.updateAgentState).toHaveBeenCalledTimes(2);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-not-matching',
            met: false,
            condition: 'not yet revised',
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-matching',
            met: false,
            condition: '  revised rpc goal  ',
        });

        await expect(promise).resolves.toEqual({ ok: true });
        expect(settled).toBe(true);
        await harness.finish();
    });

    it('rejects invalid and unsupported Claude goal-action params', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler(null)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler(undefined)).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'stop' })).rejects.toThrow(/Unsupported Claude goal action/);
        await expect(handler({ action: 'edit', objective: '   ' })).rejects.toThrow(/Unsupported Claude goal action/);
        await harness.finish();
    });

    it('rejects Claude goal-action when no active Claude goal is known', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        await expect(handler({ action: 'clear' })).rejects.toThrow(/No active Claude goal/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the relevant capability is missing', async () => {
        const harness = await startRemoteRunClaudeHarness({
            metadata: {
                claudeSessionId: 'claude-session-1',
                slashCommands: [],
            },
        });
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-no-capabilities',
            met: false,
            condition: 'goal without actions',
        });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/clear goal action is not supported/);
        await expect(handler({ action: 'edit', objective: 'new goal' })).rejects.toThrow(/edit goal action is not supported/);
        await harness.finish();
    });

    it('rejects Claude goal-action when the message queue is busy', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-busy-queue',
            met: false,
            condition: 'busy queue goal',
        });
        harness.loopOptions.messageQueue.push('already queued', { permissionMode: 'default' });

        await expect(handler({ action: 'clear' })).rejects.toThrow(/queue is busy|busy/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({ message: 'already queued' }),
        ]);
        await harness.finish();
    });

    it('rejects Claude goal-action while local mode owns the transcript', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-local-mode',
            met: false,
            condition: 'local mode goal',
        });
        harness.loopOptions.onModeChange('local');

        await expectPromptRejectsFast(handler({ action: 'clear' }), /not ready|remote/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([]);
        await harness.finish();
    });

    it('keeps the picked model and effort after an abort resets the other mode defaults', async () => {
        const harness = await startRemoteRunClaudeHarness();
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0][0];

        await userMessageHandler({
            content: { text: 'first turn' },
            meta: { model: 'claude-fable-5-20260115', effort: 'high' },
        });
        expect(harness.loopOptions.messageQueue.queue[0].mode).toMatchObject({
            model: 'claude-fable-5-20260115',
            effort: 'high',
        });

        // Aborting the turn must not silently revert the picker's choice —
        // the app only sends meta.model/meta.effort when the user changes them.
        harness.loopOptions.onAbort();

        await userMessageHandler({
            content: { text: 'second turn' },
            meta: {},
        });
        expect(harness.loopOptions.messageQueue.queue[1].mode).toMatchObject({
            model: 'claude-fable-5-20260115',
            effort: 'high',
        });

        await harness.finish();
    });

    it('rejects Claude goal-action while Claude is still thinking', async () => {
        const harness = await startRemoteRunClaudeHarness();
        await vi.waitFor(() => {
            expect(harness.registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        });
        const handler = harness.goalActionHandler;
        if (!handler) throw new Error('goal-action handler not registered');

        emitClaudeGoalStatus(harness.scannerOptions, {
            uuid: 'goal-att-active-thinking',
            met: false,
            condition: 'thinking goal',
        });
        harness.runtimeSession.thinking = true;

        await expectPromptRejectsFast(handler({ action: 'clear' }), /not ready|thinking/i);
        expect(harness.loopOptions.messageQueue.queue).toEqual([]);
        await harness.finish();
    });

    it('preserves the selected permission, model, and effort after aborting a turn', async () => {
        const harness = await startRemoteRunClaudeHarness();
        const userMessageHandler = harness.sessionClient.onUserMessage.mock.calls[0]?.[0];
        if (!userMessageHandler) throw new Error('user message handler not registered');

        await userMessageHandler({
            content: { text: 'start with the large-context model' },
            meta: {
                model: 'claude-fable-5[1m]',
                effort: 'max',
                permissionMode: 'bypassPermissions',
            },
        });

        harness.loopOptions.onAbort();

        // Option responses and legacy clients may omit mode metadata. The
        // runtime must retain the session selection instead of restarting the
        // SDK query with its smaller launch default.
        await userMessageHandler({
            content: { text: 'continue with this option' },
            meta: {},
        });

        expect(harness.loopOptions.messageQueue.queue).toEqual([
            expect.objectContaining({
                message: 'start with the large-context model',
                mode: expect.objectContaining({
                    permissionMode: 'bypassPermissions',
                    model: 'claude-fable-5[1m]',
                    effort: 'max',
                }),
            }),
            expect.objectContaining({
                message: 'continue with this option',
                mode: expect.objectContaining({
                    permissionMode: 'bypassPermissions',
                    model: 'claude-fable-5[1m]',
                    effort: 'max',
                }),
            }),
        ]);

        await harness.finish();
    });

    it('awaits one authoritative workflow reset before archive cleanup flushes and closes', async () => {
        const reset = createDeferred<void>();
        const resetClaudeWorkflows = vi.fn(() => reset.promise);
        const flush = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const harness = await startRemoteRunClaudeHarness({ resetClaudeWorkflows, flush, close });
        const archiveCleanup = mockRegisterKillSessionHandler.mock.calls.at(-1)?.[1];
        if (!archiveCleanup) throw new Error('archive cleanup handler not registered');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const cleanup = archiveCleanup();
        expect(resetClaudeWorkflows).toHaveBeenCalledOnce();
        const duplicateCleanup = archiveCleanup();
        const runAfterCleanup = harness.finishAfterCleanup();
        await Promise.resolve();

        expect(resetClaudeWorkflows).toHaveBeenCalledTimes(1);
        expect(flush).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();

        reset.resolve();
        await Promise.all([cleanup, duplicateCleanup, runAfterCleanup]);

        expect(resetClaudeWorkflows).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(resetClaudeWorkflows.mock.invocationCallOrder[0])
            .toBeLessThan(flush.mock.invocationCallOrder[0]);
        expect(flush.mock.invocationCallOrder[0])
            .toBeLessThan(close.mock.invocationCallOrder[0]);
        expect(close.mock.invocationCallOrder[0])
            .toBeLessThan(exitSpy.mock.invocationCallOrder[0]);

        exitSpy.mockRestore();
    });

    it('continues archive cleanup when the authoritative workflow reset fails', async () => {
        const resetFailure = new Error('workflow reset timed out');
        const resetClaudeWorkflows = vi.fn(async () => { throw resetFailure; });
        const flush = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const harness = await startRemoteRunClaudeHarness({ resetClaudeWorkflows, flush, close });
        const archiveCleanup = mockRegisterKillSessionHandler.mock.calls.at(-1)?.[1];
        if (!archiveCleanup) throw new Error('archive cleanup handler not registered');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await archiveCleanup();

        expect(resetClaudeWorkflows).toHaveBeenCalledOnce();
        expect(flush).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(0);

        exitSpy.mockRestore();
        await harness.finishAfterCleanup();
    });

    it('resets workflows before flush and close on normal loop exit', async () => {
        const resetClaudeWorkflows = vi.fn(async () => {});
        const flush = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const harness = await startRemoteRunClaudeHarness({ resetClaudeWorkflows, flush, close });

        await harness.finish();

        expect(resetClaudeWorkflows).toHaveBeenCalledOnce();
        expect(resetClaudeWorkflows).toHaveBeenCalledWith({ seal: true });
        expect(resetClaudeWorkflows.mock.invocationCallOrder[0])
            .toBeLessThan(flush.mock.invocationCallOrder[0]);
        expect(flush.mock.invocationCallOrder[0])
            .toBeLessThan(close.mock.invocationCallOrder[0]);
    });

    it('keeps normal and archive cleanup single-flight when archive arrives during finalization', async () => {
        const reset = createDeferred<void>();
        const blockedFlush = createDeferred<void>();
        const resetClaudeWorkflows = vi.fn(() => reset.promise);
        const flush = vi.fn(() => blockedFlush.promise);
        const close = vi.fn(async () => {});
        const harness = await startRemoteRunClaudeHarness({ resetClaudeWorkflows, flush, close });
        const archiveCleanup = mockRegisterKillSessionHandler.mock.calls.at(-1)?.[1];
        if (!archiveCleanup) throw new Error('archive cleanup handler not registered');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        harness.resolveLoop(7);
        await vi.waitFor(() => {
            expect(resetClaudeWorkflows).toHaveBeenCalled();
        });

        const archiveDuringReset = archiveCleanup();
        reset.resolve();
        await vi.waitFor(() => {
            expect(flush).toHaveBeenCalled();
        });
        const archiveDuringFlush = archiveCleanup();
        blockedFlush.resolve();

        await Promise.all([harness.runPromise, archiveDuringReset, archiveDuringFlush]);

        expect(resetClaudeWorkflows).toHaveBeenCalledOnce();
        expect(resetClaudeWorkflows).toHaveBeenCalledWith({ seal: true });
        expect(flush).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(harness.runtimeSession.cleanup).toHaveBeenCalledOnce();
        expect(harness.sessionClient.sendSessionDeath).toHaveBeenCalledOnce();
        expect(harness.api.deactivateSession).toHaveBeenCalledOnce();
        expect(harness.remoteScanner.cleanup).toHaveBeenCalledOnce();
        expect(harness.happyServer.stop).toHaveBeenCalledOnce();
        expect(harness.hookServer.stop).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(7);
        expect(harness.sessionClient.getMetadata()).not.toHaveProperty('lifecycleState');

        exitSpy.mockRestore();
    });
});
