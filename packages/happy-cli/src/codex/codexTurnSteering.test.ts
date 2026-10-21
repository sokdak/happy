import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { enqueueCodexUserText } from './codexClearCommand';
import { hashCodexEnhancedMode, type CodexEnhancedMode } from './codexPrompt';
import { CodexTurnSteering, type CodexPendingMessage } from './codexTurnSteering';

const mode: CodexEnhancedMode = { permissionMode: 'auto', model: 'gpt-test', effort: 'medium' };
const target = { threadId: 'thread', turnId: 'turn' };
const message = (text: string, overrides: Partial<CodexPendingMessage> = {}): CodexPendingMessage => ({ message: text, mode, ...overrides });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness() {
    const queue = new MessageQueue2<CodexEnhancedMode>(hashCodexEnhancedMode);
    const steer = vi.fn<(input: CodexPendingMessage, destination: typeof target) => Promise<boolean>>().mockResolvedValue(true);
    const onError = vi.fn();
    const router = new CodexTurnSteering({
        enqueue: input => { enqueueCodexUserText({ text: input.message, mode: input.mode, queue, attachments: input.attachments }); },
        hasQueuedMessages: () => queue.size() > 0,
        steer, onError,
    });
    return { router, queue, steer, onError, queued: () => queue.queue.map(item => item.message) };
}

describe('CodexTurnSteering', () => {
    it('queues idle input and delivers mid-turn instructions immediately without another queued turn', async () => {
        const h = harness();
        h.router.submit(message('initial request'));
        expect(h.queued()).toEqual(['initial request']);
        await h.queue.waitForMessagesAndGetAsString();
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('Use the existing helper instead'));
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledWith(message('Use the existing helper instead'), target));
        await turn.finish();
        expect(h.queued()).toEqual([]);
    });

    it('waits for the turn/start acknowledgement before sending early follow-ups', async () => {
        const h = harness();
        const turn = h.router.beginTurn(mode);
        h.router.submit(message('Additional instruction'));
        await Promise.resolve();
        expect(h.steer).not.toHaveBeenCalled();
        turn.onTurnStarted(target);
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
        await turn.finish();
        expect(h.queued()).toEqual([]);
    });

    it('serializes follow-ups and preserves each message and its attachments', async () => {
        const h = harness();
        const first = deferred<boolean>();
        h.steer.mockReturnValueOnce(first.promise);
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        const image = { data: new Uint8Array([1]), mimeType: 'image/png', name: 'reference.png' };
        const imageMessage = message('Use this reference', { attachments: [image] });
        h.router.submit(message('First instruction'));
        h.router.submit(imageMessage);
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
        first.resolve(true);
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(2));
        expect(h.steer).toHaveBeenNthCalledWith(2, imageMessage, target);
        await turn.finish();
        expect(h.queued()).toEqual([]);
    });

    it.each(['rejected', 'failed'] as const)('preserves FIFO input when steering is %s', async result => {
        const h = harness();
        if (result === 'rejected') h.steer.mockResolvedValueOnce(false);
        else h.steer.mockRejectedValueOnce(new Error('Unsupported method'));
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('First instruction'));
        h.router.submit(message('Second instruction'));
        await vi.waitFor(() => expect(h.queue.size()).toBe(2));
        await turn.finish();
        expect(h.queued()).toEqual(['First instruction', 'Second instruction']);
        expect(h.steer).toHaveBeenCalledTimes(1);
        expect(h.onError).toHaveBeenCalledTimes(result === 'failed' ? 1 : 0);
    });

    it.each([
        { message: '/clear', mode },
        { message: '/goal Finish the refactor', mode },
        { message: 'Use a different model', mode: { ...mode, model: 'other' } },
        { message: 'Change effort', mode: { ...mode, effort: 'high' as const } },
        { message: 'Change permissions', mode: { ...mode, permissionMode: 'yolo' as const } },
        { message: 'Change instructions', mode: { ...mode, appendSystemPrompt: 'New system prompt' } },
    ])('keeps commands and turn-setting changes as queued turns: $message', async input => {
        const h = harness();
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(input);
        h.router.submit(message('Then do this'));
        await vi.waitFor(() => expect(h.queue.size()).toBe(2));
        await turn.finish();
        expect(h.steer).not.toHaveBeenCalled();
        expect(h.queued()).toEqual([input.message, 'Then do this']);
    });

    it('does not steer new messages ahead of a pre-existing queued request', async () => {
        const h = harness();
        h.router.submit(message('Already queued'));
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('New instruction'));
        await turn.finish();
        expect(h.steer).not.toHaveBeenCalled();
        expect(h.queued()).toEqual(['Already queued', 'New instruction']);
    });

    it('waits for a late acceptance and never replays accepted input after turn completion', async () => {
        const h = harness();
        const ack = deferred<boolean>();
        h.steer.mockReturnValueOnce(ack.promise);
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('Accepted instruction'));
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
        let finished = false;
        const finish = turn.finish().then(() => { finished = true; });
        h.router.submit(message('Arrived while finishing'));
        await Promise.resolve();
        expect(finished).toBe(false);
        ack.resolve(true);
        await finish;
        expect(h.queued()).toEqual(['Arrived while finishing']);
    });

    it('keeps newer input behind a late rejection while the turn is finishing', async () => {
        const h = harness();
        const ack = deferred<boolean>();
        h.steer.mockReturnValueOnce(ack.promise);
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('Rejected instruction'));
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
        const finish = turn.finish();
        h.router.submit(message('New instruction'));
        ack.resolve(false);
        await finish;
        expect(h.queued()).toEqual(['Rejected instruction', 'New instruction']);
    });

    it('settles follow-ups even when turn/start fails without an acknowledgement', async () => {
        const h = harness();
        const start = deferred<void>();
        const run = h.router.runTurn(mode, () => start.promise);
        h.router.submit(message('Preserve this instruction'));
        const failed = expect(run).rejects.toThrow('Failed to start');
        start.reject(new Error('Failed to start'));
        await failed;
        expect(h.queued()).toEqual(['Preserve this instruction']);
        expect(h.steer).not.toHaveBeenCalled();
    });

    it('applies /clear after an earlier steering rejection without reordering later instructions', async () => {
        const h = harness();
        const ack = deferred<boolean>();
        h.steer.mockReturnValueOnce(ack.promise);
        const turn = h.router.beginTurn(mode);
        turn.onTurnStarted(target);
        h.router.submit(message('Older instruction'));
        h.router.submit(message('/clear'));
        h.router.submit(message('After clear'));
        await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
        ack.resolve(false);
        await vi.waitFor(() => expect(h.queued()).toEqual(['/clear', 'After clear']));
        await turn.finish();
    });
});
