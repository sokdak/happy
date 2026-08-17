import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockClaudeLocal,
    mockCreateSessionScanner,
} = vi.hoisted(() => ({
    mockClaudeLocal: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
}));

vi.mock('./claudeLocal', () => ({
    claudeLocal: mockClaudeLocal,
    ExitCodeError: class ExitCodeError extends Error {
        exitCode: number;

        constructor(exitCode: number) {
            super(`Process exited with code: ${exitCode}`);
            this.exitCode = exitCode;
        }
    },
}));

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import { claudeLocalLauncher } from './claudeLocalLauncher';
import { RawJSONLinesSchema } from './types';

type QueueHandler = (message: string, mode: { permissionMode: 'default' }) => void;
type ScannerOptions = {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: any) => void;
};

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('claudeLocalLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => {}),
        });
    });

    it('aborts local Claude Code when an app message requests remote control', async () => {
        const localRun = createDeferred<void>();
        const initialReset = createDeferred<void>();
        const observed: {
            queueHandler?: QueueHandler;
            localAbortSignal?: AbortSignal;
        } = {};
        let queuedMessages = 0;

        mockClaudeLocal.mockImplementation(async (opts: { abort: AbortSignal }) => {
            observed.localAbortSignal = opts.abort;
            await localRun.promise;
        });

        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                resetClaudeWorkflows: vi.fn().mockReturnValueOnce(initialReset.promise),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(() => {
                    queuedMessages = 0;
                }),
                setOnMessage: vi.fn((handler: QueueHandler | null) => {
                    observed.queueHandler = handler ?? undefined;
                }),
                size: vi.fn(() => queuedMessages),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        const launcher = claudeLocalLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(1);
        });
        expect(mockClaudeLocal).not.toHaveBeenCalled();
        initialReset.resolve();

        await vi.waitFor(() => {
            expect(observed.localAbortSignal).toBeDefined();
            expect(observed.queueHandler).toBeDefined();
        });
        expect(session.client.resetClaudeWorkflows).toHaveBeenCalled();
        expect(Math.min(...session.client.resetClaudeWorkflows.mock.invocationCallOrder))
            .toBeLessThan(Math.min(...mockClaudeLocal.mock.invocationCallOrder));

        queuedMessages = 1;
        const handler = observed.queueHandler;
        const signal = observed.localAbortSignal;
        if (!handler || !signal) {
            throw new Error('local launcher did not start');
        }
        handler('from app', { permissionMode: 'default' });

        await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
        });
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('cancelled');

        localRun.resolve();

        await expect(launcher).resolves.toEqual({ type: 'switch' });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
        expect(session.client.resetClaudeWorkflows.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('routes scanner messages through local transcript replay so attachments can be uploaded', async () => {
        const localRun = createDeferred<void>();
        let scannerOptions: ScannerOptions | undefined;

        mockCreateSessionScanner.mockImplementation(async (opts: ScannerOptions) => {
            scannerOptions = opts;
            return {
                onNewSession: vi.fn(),
                cleanup: vi.fn(async () => {}),
            };
        });
        mockClaudeLocal.mockImplementation(async () => {
            await localRun.promise;
        });

        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                resetClaudeWorkflows: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        const launcher = claudeLocalLauncher(session as any);

        await vi.waitFor(() => {
            expect(scannerOptions).toBeDefined();
        });

        scannerOptions!.onMessage({
            type: 'user',
            uuid: 'u-image-1',
            message: {
                content: [
                    { type: 'text', text: 'look' },
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
                    },
                ],
            },
        });

        await vi.waitFor(() => {
            expect(session.client.sendClaudeSessionMessageFromLocalTranscript).toHaveBeenCalledWith(
                expect.objectContaining({ uuid: 'u-image-1' }),
            );
        });
        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalled();

        localRun.resolve();
        await launcher;
    });

    it('reports the underlying error when a launch throws, instead of a bare notice', async () => {
        // The SDK surfaces an unresolvable native binary as a plain Error; the
        // launcher used to drop it and report only "Process exited unexpectedly".
        const sdkFailure = new Error(
            'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.'
        );
        mockClaudeLocal
            .mockRejectedValueOnce(sdkFailure)
            .mockResolvedValueOnce(undefined);

        const session = {
            sessionId: 'claude-session-3',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                resetClaudeWorkflows: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        // The failed launch retries, so the second attempt settles the launcher.
        await expect(claudeLocalLauncher(session as any)).resolves.toEqual({ type: 'exit', code: 0 });

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: `Process exited unexpectedly: ${sdkFailure.message}`,
        });
    });

    it('authoritatively resets workflows after scanner cleanup drains final transcript messages', async () => {
        const events: string[] = [];
        // A system transcript line carrying the uuid RawJSONLinesSchema
        // requires — i.e. something the real scanner would actually forward.
        const finalDrainMessage = {
            type: 'system',
            uuid: 'f0c1d9e4-0f5a-4a1b-9d21-7c3f8b2a6e10',
            content: 'final drained transcript line',
        };
        const earlyReset = createDeferred<void>();
        const finalReset = createDeferred<void>();
        let resetCalls = 0;
        let scannerOptions: ScannerOptions | undefined;
        mockCreateSessionScanner.mockImplementation(async (options: ScannerOptions) => {
            scannerOptions = options;
            return {
                onNewSession: vi.fn(),
                cleanup: vi.fn(async () => {
                    events.push('cleanup');
                    // The real scanner only forwards lines that survive
                    // RawJSONLinesSchema, so a fixture the schema would reject
                    // proves nothing about production behavior.
                    expect(RawJSONLinesSchema.safeParse(finalDrainMessage).success).toBe(true);
                    options.onMessage(finalDrainMessage as any);
                }),
            };
        });
        mockClaudeLocal.mockResolvedValueOnce(undefined);

        const session = {
            sessionId: 'claude-session-final-drain',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {
                    events.push('send');
                }),
                closeClaudeSessionTurn: vi.fn(),
                resetClaudeWorkflows: vi.fn(() => {
                    resetCalls += 1;
                    events.push('reset');
                    if (resetCalls === 2) return earlyReset.promise;
                    if (resetCalls === 3) return finalReset.promise;
                    return Promise.resolve();
                }),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        let launcherResolved = false;
        const launcher = claudeLocalLauncher(session as any).then((result) => {
            launcherResolved = true;
            return result;
        });

        await vi.waitFor(() => {
            expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(2);
        });
        expect(events).not.toContain('cleanup');

        earlyReset.resolve();
        await vi.waitFor(() => {
            expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(3);
        });
        expect(launcherResolved).toBe(false);

        finalReset.resolve();
        await expect(launcher).resolves.toEqual({ type: 'exit', code: 0 });

        expect(scannerOptions).toBeDefined();
        expect(events).toContain('cleanup');
        expect(events).toContain('send');
        const lastReset = events.lastIndexOf('reset');
        expect(lastReset).toBeGreaterThan(events.lastIndexOf('cleanup'));
        expect(lastReset).toBeGreaterThan(events.lastIndexOf('send'));
    });

    it('still cleans up and attempts the final reset when the early cleanup reset fails', async () => {
        const earlyFailure = new Error('early reset failed');
        const cleanup = vi.fn(async () => {});
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup,
        });
        mockClaudeLocal.mockResolvedValueOnce(undefined);

        let resetCalls = 0;
        const session = {
            sessionId: 'claude-session-reset-failure',
            path: '/tmp/project',
            client: {
                sendClaudeSessionMessage: vi.fn(),
                sendClaudeSessionMessageFromLocalTranscript: vi.fn(async () => {}),
                closeClaudeSessionTurn: vi.fn(),
                resetClaudeWorkflows: vi.fn(() => {
                    resetCalls += 1;
                    if (resetCalls === 2) return Promise.reject(earlyFailure);
                    return Promise.resolve();
                }),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
                },
            },
            queue: {
                reset: vi.fn(),
                setOnMessage: vi.fn(),
                size: vi.fn(() => 0),
            },
            addSessionFoundCallback: vi.fn(),
            removeSessionFoundCallback: vi.fn(),
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            sandboxConfig: undefined,
        };

        await expect(claudeLocalLauncher(session as any)).rejects.toBe(earlyFailure);

        expect(cleanup).toHaveBeenCalledOnce();
        expect(session.client.resetClaudeWorkflows).toHaveBeenCalledTimes(3);
    });

    // Documents why local mode publishes no workflow state today, so nobody
    // reads the mocked scanner above as evidence that it does.
    //
    // Two independent reasons, both verified:
    //  1. Claude Code does not write task_* system lines into transcript JSONL
    //     files at all, so there is nothing for the scanner to pick up.
    //  2. Even if such a line appeared, the shape the workflow tracker expects
    //     ({ type: 'system', subtype: 'task_started', task_id, task_type })
    //     carries no uuid, and the system variant of RawJSONLinesSchema
    //     requires one — the scanner drops it before onMessage ever runs.
    //
    // Workflow progress therefore reaches the app only from remote mode, where
    // claudeRemote.ts reads task_* events off the SDK stream instead of the
    // transcript. Deleting this test without changing that pipeline would just
    // restore the false confidence it exists to prevent.
    it('documents that transcript task_* events cannot feed local-mode workflow state', () => {
        const transcriptTaskEvent = {
            type: 'system',
            subtype: 'task_started',
            task_id: 'workflow-1',
            task_type: 'local_workflow',
        };

        const parsed = RawJSONLinesSchema.safeParse(transcriptTaskEvent);

        expect(parsed.success).toBe(false);
        expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')))
            .toContain('uuid');
    });
});
