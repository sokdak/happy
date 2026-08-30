import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockClaudeRemote,
    mockCleanupStdinAfterInk,
} = vi.hoisted(() => ({
    mockClaudeRemote: vi.fn(),
    mockCleanupStdinAfterInk: vi.fn(async () => {}),
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: mockClaudeRemote,
}));

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponseLookup = vi.fn(() => new Map());
        getResponseForToolUseId = vi.fn();
        handleToolCall = vi.fn(async () => ({ behavior: 'allow' }));
        isAborted = vi.fn(() => false);
        handleModeChange = vi.fn();
        setPermissionModeUpdater = vi.fn();
    },
}));

vi.mock('@/ui/ink/messageBuffer', () => ({
    MessageBuffer: class {
        addMessage = vi.fn();
        clear = vi.fn();
    },
}));

vi.mock('@/ui/messageFormatterInk', () => ({
    formatClaudeMessageForInk: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

vi.mock('@/utils/terminalStdinCleanup', () => ({
    cleanupStdinAfterInk: mockCleanupStdinAfterInk,
}));

vi.mock('./utils/questionNotification', () => ({
    getAskUserQuestionToolCallIds: vi.fn(() => []),
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('claudeRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('resets workflows after flushing queued events without blocking on reset ACKs', async () => {
        const handlers = new Map<string, () => Promise<void>>();
        const initialReset = createDeferred<void>();
        const earlyReset = createDeferred<void>();
        const finalReset = createDeferred<void>();
        let resetCalls = 0;
        const session = {
            sessionId: 'claude-session-remote-cleanup',
            path: '/tmp/project',
            client: {
                sessionId: 'claude-session-remote-cleanup',
                sendClaudeSessionMessage: vi.fn(),
                resetClaudeWorkflows: vi.fn(() => {
                    resetCalls += 1;
                    if (resetCalls === 1) return initialReset.promise;
                    if (resetCalls === 2) return earlyReset.promise;
                    if (resetCalls === 3) return finalReset.promise;
                    return Promise.resolve();
                }),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                getMetadata: vi.fn(() => ({})),
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: () => Promise<void>) => {
                        handlers.set(method, handler);
                    }),
                },
            },
            queue: {
                size: vi.fn(() => 0),
                waitForMessagesAndGetAsString: vi.fn(),
            },
            api: {
                push: vi.fn(() => ({
                    sendSessionNotification: vi.fn(),
                })),
            },
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            clearSessionId: vi.fn(),
            allowedTools: [],
            mcpServers: {},
            hookSettingsPath: '/tmp/hook-settings.json',
            jsRuntime: undefined,
            claudeEnvVars: undefined,
            claudeArgs: undefined,
        };

        mockClaudeRemote.mockImplementationOnce(async (options: { onMessage: (message: unknown) => void }) => {
            options.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
                },
            });
            options.onMessage({
                type: 'system',
                subtype: 'task_started',
                task_id: 'workflow-1',
                task_type: 'local_workflow',
                workflow_name: 'inspect-packages',
            });
            options.onMessage({
                type: 'system',
                subtype: 'task_progress',
                task_id: 'workflow-1',
                usage: { total_tokens: 25000 },
            });
            void handlers.get('switch')?.();
        });

        let launcherResolved = false;
        const launcher = claudeRemoteLauncher(session as any).then((result) => {
            launcherResolved = true;
            return result;
        });

        await expect(launcher).resolves.toBe('switch');
        expect(launcherResolved).toBe(true);
        expect(mockClaudeRemote).toHaveBeenCalledOnce();
        expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(3);

        const sentMessages = session.client.sendClaudeSessionMessage.mock.calls.map(([message]) => message);
        const delayedAssistant = sentMessages.findIndex((message: any) => message.type === 'assistant');
        const taskStarted = sentMessages.findIndex((message: any) => message.subtype === 'task_started');
        const taskProgress = sentMessages.findIndex((message: any) => message.subtype === 'task_progress');
        expect(delayedAssistant).toBeGreaterThanOrEqual(0);
        expect(taskStarted).toBeGreaterThan(delayedAssistant);
        expect(taskProgress).toBeGreaterThan(taskStarted);

        const finalResetOrder = Math.max(...session.client.resetClaudeWorkflows.mock.invocationCallOrder);
        const lastDeliveryOrder = Math.max(...session.client.sendClaudeSessionMessage.mock.invocationCallOrder);
        expect(finalResetOrder).toBeGreaterThan(lastDeliveryOrder);
    });

    it('attempts the final reset when the early cleanup reset fails', async () => {
        const handlers = new Map<string, () => Promise<void>>();
        const earlyFailure = new Error('early reset failed');
        let resetCalls = 0;
        const session = {
            sessionId: 'claude-session-remote-reset-failure',
            path: '/tmp/project',
            client: {
                sessionId: 'claude-session-remote-reset-failure',
                sendClaudeSessionMessage: vi.fn(),
                resetClaudeWorkflows: vi.fn(() => {
                    resetCalls += 1;
                    if (resetCalls === 2) return Promise.reject(earlyFailure);
                    return Promise.resolve();
                }),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                getMetadata: vi.fn(() => ({})),
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: () => Promise<void>) => {
                        handlers.set(method, handler);
                    }),
                },
            },
            queue: {
                size: vi.fn(() => 0),
                waitForMessagesAndGetAsString: vi.fn(),
            },
            api: {
                push: vi.fn(() => ({ sendSessionNotification: vi.fn() })),
            },
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            clearSessionId: vi.fn(),
            allowedTools: [],
            mcpServers: {},
            hookSettingsPath: '/tmp/hook-settings.json',
            jsRuntime: undefined,
            claudeEnvVars: undefined,
            claudeArgs: undefined,
        };

        mockClaudeRemote.mockImplementationOnce(async () => {
            void handlers.get('switch')?.();
        });

        await expect(claudeRemoteLauncher(session as any)).resolves.toBe('switch');

        expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(3);
    });
});
