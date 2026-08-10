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

describe('claudeRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('resets workflows after flushing a delayed message and queued workflow events', async () => {
        const handlers = new Map<string, () => Promise<void>>();
        const session = {
            sessionId: 'claude-session-remote-cleanup',
            path: '/tmp/project',
            client: {
                sessionId: 'claude-session-remote-cleanup',
                sendClaudeSessionMessage: vi.fn(),
                resetClaudeWorkflows: vi.fn(),
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

        await expect(claudeRemoteLauncher(session as any)).resolves.toBe('switch');

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
});
