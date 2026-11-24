import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import type { CodexUserInputHandler } from './utils/userInputHandler';

/** Expose question cards in Default mode as well as Codex's native Plan mode. */
export async function startCodexHappyServer(
    session: Pick<ApiSessionClient, 'sessionId' | 'sendClaudeSessionMessage'>,
    userInputHandler: Pick<CodexUserInputHandler, 'handle'>,
) {
    const pending = new Set<AbortController>();
    const cancelQuestions = () => {
        for (const controller of pending) controller.abort();
        pending.clear();
    };
    const server = await startHappyServer(session, {
        requestUserInput: async (questions, signal) => {
            const controller = new AbortController();
            pending.add(controller);
            try {
                return await userInputHandler.handle({
                    callId: randomUUID(),
                    questions: questions.map(question => ({ ...question, options: question.options ?? null })),
                    signal: AbortSignal.any([signal, controller.signal]),
                });
            } finally {
                pending.delete(controller);
            }
        },
    });
    return {
        ...server,
        cancelQuestions,
        mcpServers: {
            happy: {
                // Use node explicitly: Windows cannot execute the bridge's shebang.
                command: process.execPath,
                args: ['--no-warnings', '--no-deprecation', join(projectPath(), 'bin', 'happy-mcp.mjs'),
                    '--url', server.url, '--request-user-input'],
                // Human answers must survive Codex's normal short MCP timeout.
                tool_timeout_sec: 24 * 60 * 60,
            },
        },
        stop: () => {
            cancelQuestions();
            server.stop();
        },
    };
}
