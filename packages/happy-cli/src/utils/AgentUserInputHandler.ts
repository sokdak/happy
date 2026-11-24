import { z } from 'zod';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentCommunication, AgentQuestionAnswer, CompletedAgentCommunication } from '@/api/types';
import type { UserInputHandler } from '@/codex/codexAppServerClient';
import type { ToolRequestUserInputResponse } from '@/codex/codexAppServerTypes';

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
    title: string;
    description: string;
    resolve: (response: ToolRequestUserInputResponse) => void;
    cleanup: () => void;
};

export type AgentUserInputQuestion = Parameters<UserInputHandler>[0]['questions'][number] & {
    multiSelect?: boolean;
};

/** Bridges agent questions to the app's communication RPC and cards. */
export class AgentUserInputHandler {
    private pending = new Map<string, PendingInput>();
    private handledIds = new Set<string>();

    constructor(
        private session: ApiSessionClient,
        private getSessionTurnId: () => string | null = () => null,
        private getEnvelopeTime?: () => number,
    ) {
        this.registerRpc();
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    updateSession(session: ApiSessionClient): void {
        const previousSession = this.session;
        this.session = session;
        this.registerRpc();
        if (this.pending.size === 0 || previousSession === session) return;
        const active: Record<string, AgentCommunication> = {};
        for (const [id, entry] of this.pending) {
            active[id] = entry.communication;
            const envelopeOptions = {
                ...(entry.turnId ? { turn: entry.turnId } : {}),
                ...(this.getEnvelopeTime ? { time: this.getEnvelopeTime() } : {}),
            };
            this.session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: entry.communication.toolUseId,
                name: 'request_user_input',
                title: entry.title,
                description: entry.description,
                args: { questions: entry.communication.form.questions },
            }, envelopeOptions));
        }
        this.session.updateAgentState(state => {
            const completedCommunications = { ...state.completedCommunications };
            for (const id of Object.keys(active)) {
                delete completedCommunications[id];
            }
            return {
                ...state,
                communications: { ...state.communications, ...active },
                completedCommunications,
            };
        });
    }

    private registerRpc(): void {
        this.session.rpcHandlerManager.registerHandler('communication', async (raw: unknown) => {
            const reply = replySchema.parse(raw);
            const pending = this.pending.get(reply.id);
            if (!pending) {
                if (!this.handledIds.has(reply.id)) {
                    this.handledIds.add(reply.id);
                    this.session.updateAgentState(state => {
                        const orphan = state.communications?.[reply.id];
                        if (!orphan) return state;
                        const { [reply.id]: _removed, ...communications } = state.communications ?? {};
                        return {
                            ...state,
                            communications,
                            completedCommunications: {
                                ...state.completedCommunications,
                                [reply.id]: { ...orphan, completedAt: Date.now(), status: 'cancelled' },
                            },
                        };
                    });
                }
                return { ok: true };
            }

            const answers: Record<string, AgentQuestionAnswer> = {};
            if (reply.status === 'answered') {
                for (const question of pending.communication.form.questions) {
                    const answer = reply.answers?.[question.id];
                    const rawOptions = answer?.options ?? [];
                    const custom = answer?.custom?.trim();
                    if ((!question.multiSelect && rawOptions.length > 1) || rawOptions.some(value => !question.options.some(option => option.label === value))) {
                        throw new Error(`Invalid choice for question ${question.id}`);
                    }
                    const options = Array.from(new Set(rawOptions));
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

    readonly handle = ({ callId, questions, signal }: {
        callId: string;
        questions: AgentUserInputQuestion[];
        signal: AbortSignal;
    }): Promise<ToolRequestUserInputResponse> => {
        if (signal.aborted || questions.length === 0) return Promise.resolve({ answers: {} });
        // Happy creates its own turn ids; provider ids must not split the card
        // off from the rest of the foreground conversation.
        const turnId = this.getSessionTurnId();
        const title = questions[0]?.header ?? 'Question';
        const description = questions[0]?.question ?? 'Waiting for your answer';
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
                    ...(question.multiSelect ? { multiSelect: true } : {}),
                    allowCustom: question.isOther !== false || !question.options?.length,
                    isSecret: question.isSecret,
                    required: true,
                })),
            },
        };

        return new Promise(resolve => {
            this.handledIds.add(callId);
            const cancel = () => this.complete(callId, 'cancelled');
            this.pending.set(callId, {
                communication,
                turnId,
                title,
                description,
                resolve,
                cleanup: () => signal.removeEventListener('abort', cancel),
            });
            signal.addEventListener('abort', cancel, { once: true });
            const envelopeOptions = {
                ...(turnId ? { turn: turnId } : {}),
                ...(this.getEnvelopeTime ? { time: this.getEnvelopeTime() } : {}),
            };
            this.session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: callId,
                name: 'request_user_input',
                title,
                description,
                args: { questions: communication.form.questions },
            }, envelopeOptions));
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
        const envelopeOptions = {
            ...(pending.turnId ? { turn: pending.turnId } : {}),
            ...(this.getEnvelopeTime ? { time: this.getEnvelopeTime() } : {}),
        };
        this.session.sendSessionProtocolMessage(createEnvelope('agent', {
            t: 'tool-call-end', call: pending.communication.toolUseId,
        }, envelopeOptions));

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
        const pendingEntries = [...this.pending.entries()];
        this.pending.clear();
        const now = Date.now();
        for (const [, entry] of pendingEntries) {
            entry.cleanup();
        }
        this.session.updateAgentState(state => {
            const completedCommunications: Record<string, CompletedAgentCommunication> = { ...state.completedCommunications };
            for (const [id, communication] of Object.entries(state.communications ?? {})) {
                completedCommunications[id] = { ...communication, completedAt: now, status: 'cancelled' };
            }
            for (const [id, entry] of pendingEntries) {
                completedCommunications[id] = { ...entry.communication, completedAt: now, status: 'cancelled', answers: {} };
            }
            return { ...state, communications: {}, completedCommunications };
        });
        for (const [, entry] of pendingEntries) {
            const envelopeOptions = {
                ...(entry.turnId ? { turn: entry.turnId } : {}),
                ...(this.getEnvelopeTime ? { time: this.getEnvelopeTime() } : {}),
            };
            this.session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-end', call: entry.communication.toolUseId,
            }, envelopeOptions));
            entry.resolve({ answers: {} });
        }
    }
}
