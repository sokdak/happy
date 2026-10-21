import { z } from 'zod';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentCommunication, AgentQuestionAnswer, CompletedAgentCommunication } from '@/api/types';
import type { UserInputHandler } from '../codexAppServerClient';
import type { ToolRequestUserInputResponse } from '../codexAppServerTypes';

const replySchema = z.object({
    id: z.string(),
    kind: z.literal('form'),
    status: z.enum(['answered', 'cancelled']),
    answers: z.record(z.string(), z.object({
        options: z.array(z.string()).default([]),
        custom: z.string().nullish(),
    })).optional(),
});

type PendingInput = {
    communication: AgentCommunication;
    turnId: string | null;
    resolve: (response: ToolRequestUserInputResponse) => void;
    cleanup: () => void;
};

/** Bridges native Codex questions to the app's communication RPC and cards. */
export class CodexUserInputHandler {
    private pending = new Map<string, PendingInput>();

    constructor(private session: ApiSessionClient, private getSessionTurnId: () => string | null = () => null) {
        this.registerRpc();
    }

    updateSession(session: ApiSessionClient): void {
        this.session = session;
        this.registerRpc();
    }

    private registerRpc(): void {
        this.session.rpcHandlerManager.registerHandler('communication', async (raw: unknown) => {
            const reply = replySchema.parse(raw);
            const pending = this.pending.get(reply.id);
            if (!pending) return { ok: true };

            const answers: Record<string, AgentQuestionAnswer> = {};
            if (reply.status === 'answered') {
                for (const question of pending.communication.form.questions) {
                    const answer = reply.answers?.[question.id];
                    const options = answer?.options ?? [];
                    const custom = answer?.custom?.trim();
                    if (options.length > 1 || options.some(value => !question.options.some(option => option.label === value))) {
                        throw new Error(`Invalid choice for question ${question.id}`);
                    }
                    if (custom && question.allowCustom === false) {
                        throw new Error(`Written answers are not allowed for question ${question.id}`);
                    }
                    if (options.length === 0 && !custom) throw new Error(`Answer required for question ${question.id}`);
                    answers[question.id] = { options, ...(custom ? { custom } : {}) };
                }
            }
            this.complete(reply.id, reply.status, answers);
            return { ok: true };
        });
    }

    readonly handle: UserInputHandler = ({ callId, questions, signal }) => {
        if (signal.aborted || questions.length === 0) return Promise.resolve({ answers: {} });
        // Happy creates its own turn ids; provider ids must not split the card
        // off from the rest of the foreground conversation.
        const turnId = this.getSessionTurnId();
        const communication: AgentCommunication = {
            kind: 'form',
            createdAt: Date.now(),
            toolUseId: callId,
            form: {
                questions: questions.map(question => ({
                    id: question.id,
                    header: question.header,
                    question: question.question,
                    options: question.options ?? [],
                    allowCustom: question.isOther !== false || !question.options?.length,
                    isSecret: question.isSecret,
                    required: true,
                })),
            },
        };

        return new Promise(resolve => {
            const cancel = () => this.complete(callId, 'cancelled');
            this.pending.set(callId, {
                communication,
                turnId,
                resolve,
                cleanup: () => signal.removeEventListener('abort', cancel),
            });
            signal.addEventListener('abort', cancel, { once: true });
            this.session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: callId,
                name: 'request_user_input',
                title: questions[0]?.header ?? 'Question',
                description: questions[0]?.question ?? 'Waiting for your answer',
                args: { questions: communication.form.questions },
            }, turnId ? { turn: turnId } : {}));
            this.session.updateAgentState(state => {
                const { [callId]: _previous, ...completedCommunications } = state.completedCommunications ?? {};
                return {
                    ...state,
                    communications: { ...state.communications, [callId]: communication },
                    completedCommunications,
                };
            });
        });
    };

    private complete(id: string, status: 'answered' | 'cancelled', answers: Record<string, AgentQuestionAnswer> = {}): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        this.session.updateAgentState(state => {
            const { [id]: _pending, ...communications } = state.communications ?? {};
            return {
                ...state,
                communications,
                completedCommunications: {
                    ...state.completedCommunications,
                    [id]: { ...pending.communication, completedAt: Date.now(), status, answers },
                },
            };
        });
        this.session.sendSessionProtocolMessage(createEnvelope('agent', {
            t: 'tool-call-end', call: pending.communication.toolUseId,
        }, pending.turnId ? { turn: pending.turnId } : {}));

        const response: ToolRequestUserInputResponse = { answers: {} };
        if (status === 'answered') {
            for (const [questionId, answer] of Object.entries(answers)) {
                response.answers[questionId] = {
                    answers: [...answer.options, ...(answer.custom ? [answer.custom] : [])],
                };
            }
        }
        pending.resolve(response);
    }

    /** Cancels pending and orphaned questions after an abort, restart, or exit. */
    reset(): void {
        for (const id of this.pending.keys()) this.complete(id, 'cancelled');
        this.session.updateAgentState(state => {
            const completedCommunications: Record<string, CompletedAgentCommunication> = { ...state.completedCommunications };
            for (const [id, communication] of Object.entries(state.communications ?? {})) {
                completedCommunications[id] = { ...communication, completedAt: Date.now(), status: 'cancelled' };
            }
            return { ...state, communications: {}, completedCommunications };
        });
    }
}
