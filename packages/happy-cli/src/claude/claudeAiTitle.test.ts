import { describe, expect, it, vi } from 'vitest';
import { createClaudeAiTitleApplier, parseClaudeAiTitleTranscriptEvent } from './claudeAiTitle';

function aiTitleLine(overrides: Record<string, unknown> = {}): unknown {
    return {
        type: 'ai-title',
        aiTitle: 'Wire ai-title into session titles',
        sessionId: 'claude-session-1',
        ...overrides,
    };
}

describe('parseClaudeAiTitleTranscriptEvent', () => {
    it('accepts raw Claude ai-title transcript lines', () => {
        const event = parseClaudeAiTitleTranscriptEvent(aiTitleLine());

        expect(event).toEqual({
            type: 'ai_title',
            aiTitle: 'Wire ai-title into session titles',
            sourceSessionId: 'claude-session-1',
            sourceRevision: 'claude-session-1:Wire ai-title into session titles',
        });
    });

    it('trims surrounding whitespace from the title', () => {
        const event = parseClaudeAiTitleTranscriptEvent(aiTitleLine({ aiTitle: '  Trimmed title  ' }));

        expect(event?.aiTitle).toBe('Trimmed title');
        expect(event?.sourceRevision).toBe('claude-session-1:Trimmed title');
    });

    it('rejects lines missing or emptying aiTitle', () => {
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ aiTitle: undefined }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ aiTitle: '' }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ aiTitle: '   ' }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ aiTitle: 42 }))).toBeNull();
    });

    it('rejects lines missing or emptying sessionId', () => {
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ sessionId: undefined }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ sessionId: '' }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ sessionId: '  ' }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ sessionId: { id: 'x' } }))).toBeNull();
    });

    it('rejects transcript lines that are not ai-title lines', () => {
        expect(parseClaudeAiTitleTranscriptEvent(aiTitleLine({ type: 'last-prompt' }))).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent({
            type: 'assistant',
            uuid: 'msg-1',
            sessionId: 'claude-session-1',
            message: { role: 'assistant', content: 'hello' },
        })).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent(null)).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent('ai-title')).toBeNull();
        expect(parseClaudeAiTitleTranscriptEvent([aiTitleLine()])).toBeNull();
    });
});

describe('createClaudeAiTitleApplier', () => {
    function setup(opts: { claudeSessionId?: string | null; title?: string | null } = {}) {
        let claudeSessionId = opts.claudeSessionId === undefined ? 'claude-session-1' : opts.claudeSessionId;
        let title = opts.title === undefined ? null : opts.title;
        // The real side effect lags: sending the synthetic summary only queues
        // a metadata update, and apiSession refreshes its local metadata after
        // the server acks it. So getCurrentTitle() keeps reporting the OLD
        // title for a while after a send — the stub reproduces that instead of
        // writing back, and `landMetadataWrite` plays the ack.
        const applyTitle = vi.fn();
        const apply = createClaudeAiTitleApplier({
            getClaudeSessionId: () => claudeSessionId,
            getCurrentTitle: () => title,
            applyTitle,
        });
        return {
            apply,
            applyTitle,
            landMetadataWrite: () => {
                const lastApplied = applyTitle.mock.calls.at(-1)?.[0];
                if (typeof lastApplied === 'string') title = lastApplied;
            },
            setClaudeSessionId: (value: string | null) => { claudeSessionId = value; },
        };
    }

    const event = {
        type: 'ai_title' as const,
        aiTitle: 'Generated title',
        sourceSessionId: 'claude-session-1',
        sourceRevision: 'claude-session-1:Generated title',
    };

    it('applies the title when the session has none', () => {
        const { apply, applyTitle } = setup();

        apply(event);

        expect(applyTitle).toHaveBeenCalledTimes(1);
        expect(applyTitle).toHaveBeenCalledWith('Generated title');
    });

    it('applies a given revision only once', () => {
        const { apply, applyTitle } = setup();

        apply(event);
        apply(event);

        expect(applyTitle).toHaveBeenCalledTimes(1);
    });

    it('keeps the first applied title when a rename arrives before the metadata write lands', () => {
        // Both lines are already in the transcript on a cold scan, so the
        // scanner emits them back to back — far faster than the metadata
        // round trip. Precedence must still hold on the second one.
        const { apply, applyTitle } = setup();

        apply(event);
        apply({ ...event, aiTitle: 'Second title', sourceRevision: 'claude-session-1:Second title' });

        expect(applyTitle).toHaveBeenCalledTimes(1);
        expect(applyTitle).toHaveBeenCalledWith('Generated title');
    });

    it('keeps the first applied title once the metadata write has landed', () => {
        const { apply, applyTitle, landMetadataWrite } = setup();

        apply(event);
        landMetadataWrite();
        apply({ ...event, aiTitle: 'Second title', sourceRevision: 'claude-session-1:Second title' });

        expect(applyTitle).toHaveBeenCalledTimes(1);
        expect(applyTitle).toHaveBeenCalledWith('Generated title');
    });

    it('drops events whose source session does not match the live Claude session', () => {
        const { apply, applyTitle } = setup({ claudeSessionId: 'claude-session-2' });

        apply(event);

        expect(applyTitle).not.toHaveBeenCalled();
    });

    it('accepts events when the live Claude session id is not known yet', () => {
        const { apply, applyTitle } = setup({ claudeSessionId: null });

        apply(event);

        expect(applyTitle).toHaveBeenCalledTimes(1);
    });

    it('never overwrites a title the session already has', () => {
        const { apply, applyTitle } = setup({ title: 'Human picked title' });

        apply(event);

        expect(applyTitle).not.toHaveBeenCalled();
    });

    it('treats a blank existing title as absent', () => {
        const { apply, applyTitle } = setup({ title: '   ' });

        apply(event);

        expect(applyTitle).toHaveBeenCalledTimes(1);
    });

    it('applies a dropped event later once the session id matches', () => {
        const { apply, applyTitle, setClaudeSessionId } = setup({ claudeSessionId: 'claude-session-2' });

        apply(event);
        expect(applyTitle).not.toHaveBeenCalled();

        setClaudeSessionId('claude-session-1');
        apply(event);

        expect(applyTitle).toHaveBeenCalledTimes(1);
    });
});
