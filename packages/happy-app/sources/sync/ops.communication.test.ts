import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC } = vi.hoisted(() => ({ sessionRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));

import { sessionAnswerQuestion, sessionCancelCommunication } from './ops';

beforeEach(() => sessionRPC.mockReset());

describe('communication RPC', () => {
    it('sends the communication kind, question ids, and written answer', async () => {
        sessionRPC.mockResolvedValue({ ok: true });
        const answers = { question: { options: [], custom: 'Written answer' } };
        await sessionAnswerQuestion('session', 'request', answers);
        expect(sessionRPC).toHaveBeenCalledWith('session', 'communication', { id: 'request', kind: 'form', status: 'answered', answers });
    });

    it('surfaces errors returned inside the encrypted RPC response so the form can retry', async () => {
        sessionRPC.mockResolvedValue({ error: 'Answer required' });
        await expect(sessionAnswerQuestion('session', 'request', {})).rejects.toThrow('Answer required');
        await expect(sessionCancelCommunication('session', 'request')).rejects.toThrow('Answer required');
    });
});
