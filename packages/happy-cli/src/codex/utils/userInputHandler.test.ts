import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';
import type { UserInputHandler } from '../codexAppServerClient';
import { CodexUserInputHandler } from './userInputHandler';

function harness(initialState: AgentState = {}) {
    let state = initialState;
    const rpcs = new Map<string, (reply: unknown) => Promise<void>>();
    const sendSessionProtocolMessage = vi.fn();
    const session = {
        rpcHandlerManager: { registerHandler: (name: string, handler: (reply: unknown) => Promise<void>) => rpcs.set(name, handler) },
        updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); },
        sendSessionProtocolMessage,
    } as unknown as ApiSessionClient;
    const handler = new CodexUserInputHandler(session, () => 'happy-turn');
    const controller = new AbortController();
    const params: Parameters<UserInputHandler>[0] = {
        callId: 'thread:item:question:7', threadId: 'thread', turnId: 'turn', itemId: 'item',
        signal: controller.signal,
        questions: [
            { id: 'choice', header: 'Storage', question: 'Where?', isOther: true, options: [{ label: 'Local', description: 'On disk' }] },
            { id: 'text', header: 'Name', question: 'Name?', isOther: true, isSecret: true, options: null },
        ],
    };
    const reply = (value: Record<string, unknown>) => rpcs.get('communication')!({ id: params.callId, kind: 'form', ...value });
    return { handler, session, params, controller, reply, rpcs, state: () => state, sendSessionProtocolMessage };
}

describe('CodexUserInputHandler', () => {
    it('publishes an answerable card and returns choices and written answers under the original question ids', async () => {
        const h = harness();
        const response = h.handler.handle(h.params);
        expect(h.state().communications?.[h.params.callId]).toMatchObject({
            kind: 'form', toolUseId: h.params.callId,
            form: { questions: [
                { id: 'choice', allowCustom: true, options: [{ label: 'Local' }] },
                { id: 'text', allowCustom: true, isSecret: true, options: [] },
            ] },
        });
        expect(h.sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({
            turn: 'happy-turn', ev: expect.objectContaining({ t: 'tool-call-start', call: h.params.callId, name: 'request_user_input' }),
        }));
        await h.reply({ status: 'answered', answers: { choice: { options: ['Local'] }, text: { options: [], custom: ' My name ' } } });
        await expect(response).resolves.toEqual({ answers: { choice: { answers: ['Local'] }, text: { answers: ['My name'] } } });
        expect(h.state().communications).toEqual({});
        expect(h.state().completedCommunications?.[h.params.callId].status).toBe('answered');
        expect(h.sendSessionProtocolMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ev: { t: 'tool-call-end', call: h.params.callId } }));
    });

    it('keeps the question open after malformed, incomplete, or invalid answers so the app can retry', async () => {
        const h = harness();
        const response = h.handler.handle(h.params);
        await expect(h.reply({ status: 'answered' })).rejects.toThrow('Answer required');
        await expect(h.reply({ status: 'answered', answers: { choice: { options: ['Unknown'] } } })).rejects.toThrow('Invalid choice');
        await expect(h.reply({ status: 'answered', answers: { choice: { options: 'Local' } } })).rejects.toThrow();
        expect(h.state().communications?.[h.params.callId]).toBeDefined();
        await h.reply({ status: 'answered', answers: { choice: { custom: 'Cloud' }, text: { custom: 'Name' } } });
        await expect(response).resolves.toEqual({ answers: { choice: { answers: ['Cloud'] }, text: { answers: ['Name'] } } });
    });

    it('respects questions that do not allow a written alternative', async () => {
        const h = harness();
        h.params.questions = [{ ...h.params.questions[0], isOther: false }];
        const response = h.handler.handle(h.params);
        await expect(h.reply({ status: 'answered', answers: { choice: { custom: 'Cloud' } } })).rejects.toThrow('Written answers');
        await h.reply({ status: 'answered', answers: { choice: { options: ['Local'] } } });
        await expect(response).resolves.toEqual({ answers: { choice: { answers: ['Local'] } } });
    });

    it.each(['dismiss', 'abort', 'reset'] as const)('clears a question on %s and ignores late answers', async action => {
        const h = harness();
        const response = h.handler.handle(h.params);
        if (action === 'dismiss') await h.reply({ status: 'cancelled' });
        if (action === 'abort') h.controller.abort();
        if (action === 'reset') h.handler.reset();
        await expect(response).resolves.toEqual({ answers: {} });
        await h.reply({ status: 'answered', answers: { choice: { options: ['Local'] } } });
        expect(h.state().communications).toEqual({});
        expect(h.state().completedCommunications?.[h.params.callId].status).toBe('cancelled');
        expect(h.sendSessionProtocolMessage).toHaveBeenCalledTimes(2);
    });

    it('cancels orphaned questions from a previous process on reset or direct RPC and registers the RPC after a session swap', async () => {
        const h = harness({
            communications: {
                old: { kind: 'form', createdAt: 1, toolUseId: 'old', form: { questions: [] } },
                crashOrphan: { kind: 'form', createdAt: 2, toolUseId: 'crashOrphan', form: { questions: [] } },
            },
        });
        await h.rpcs.get('communication')!({ id: 'crashOrphan', kind: 'form', status: 'cancelled' });
        expect(h.state().communications?.crashOrphan).toBeUndefined();
        expect(h.state().completedCommunications?.crashOrphan.status).toBe('cancelled');
        h.handler.reset();
        expect(h.state().communications).toEqual({});
        expect(h.state().completedCommunications?.old.status).toBe('cancelled');
        const swapped = harness();
        h.handler.updateSession(swapped.session);
        const response = h.handler.handle(h.params);
        await swapped.reply({ status: 'cancelled' });
        await expect(response).resolves.toEqual({ answers: {} });
        expect(swapped.state().completedCommunications?.[h.params.callId].status).toBe('cancelled');
    });

    it('supports multiSelect deduplication while rejecting multiple single-select choices, and replays tool-call-start on offline session swap', async () => {
        let clock = 5_000;
        const offlineStub = createOfflineSessionStub('offline-q');
        const handler = new CodexUserInputHandler(offlineStub, () => 'turn-1', () => ++clock);
        expect(handler.hasPending()).toBe(false);

        const pending = handler.handle({
            callId: 'call-multi',
            signal: new AbortController().signal,
            questions: [
                {
                    id: 'multi',
                    header: 'Targets',
                    question: 'Select targets',
                    multiSelect: true,
                    isOther: true,
                    options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }],
                },
                {
                    id: 'single',
                    header: 'Mode',
                    question: 'Select mode',
                    isOther: false,
                    options: [{ label: 'Read', description: '' }, { label: 'Write', description: '' }],
                },
            ],
        });
        expect(handler.hasPending()).toBe(true);

        // Swap from offline stub to a fresh real session while the question is pending
        const rpcs = new Map<string, (reply: unknown) => Promise<void>>();
        const swappedSend = vi.fn();
        let swappedState: AgentState = {
            completedCommunications: {
                'call-multi': {
                    kind: 'form',
                    createdAt: 1,
                    completedAt: 2,
                    status: 'cancelled',
                    toolUseId: 'call-multi',
                    form: { questions: [] },
                },
            },
        };
        const swappedUpdate = vi.fn((update: (current: AgentState) => AgentState) => {
            swappedState = update(swappedState);
        });
        const swappedSession = {
            rpcHandlerManager: { registerHandler: (name: string, fn: (reply: unknown) => Promise<void>) => rpcs.set(name, fn) },
            updateAgentState: swappedUpdate,
            sendSessionProtocolMessage: swappedSend,
        } as unknown as ApiSessionClient;
        handler.updateSession(swappedSession);

        expect(swappedState.communications?.['call-multi']?.form.questions[0].multiSelect).toBe(true);
        expect(swappedState.completedCommunications?.['call-multi']).toBeUndefined();
        expect(swappedSend).toHaveBeenCalledWith(expect.objectContaining({
            time: 5_002,
            turn: 'turn-1',
            ev: expect.objectContaining({ t: 'tool-call-start', call: 'call-multi', name: 'request_user_input' }),
        }));

        // Reject multiple options on single-select
        await expect(rpcs.get('communication')!({
            id: 'call-multi',
            kind: 'form',
            status: 'answered',
            answers: {
                multi: { options: ['Alpha', 'Beta'] },
                single: { options: ['Read', 'Write'] },
            },
        })).rejects.toThrow('Invalid choice');

        // Accept duplicate options on multiSelect and deduplicate them cleanly
        await rpcs.get('communication')!({
            id: 'call-multi',
            kind: 'form',
            status: 'answered',
            answers: {
                multi: { options: ['Alpha', 'Beta', 'Alpha'], custom: 'Gamma' },
                single: { options: ['Read'] },
            },
        });
        await expect(pending).resolves.toEqual({
            answers: {
                multi: { answers: ['Alpha', 'Beta', 'Gamma'] },
                single: { answers: ['Read'] },
            },
        });
        expect(handler.hasPending()).toBe(false);
        expect(swappedSend).toHaveBeenLastCalledWith(expect.objectContaining({ time: 5_003, turn: 'turn-1' }));
    });
});
