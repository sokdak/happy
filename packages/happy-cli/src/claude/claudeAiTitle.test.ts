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
        // Mirrors the real side effect: sending the synthetic summary writes
        // metadata.summary.text, so the session has a title from then on.
        const applyTitle = vi.fn((next: string) => { title = next; });
        const apply = createClaudeAiTitleApplier({
            getClaudeSessionId: () => claudeSessionId,
            getCurrentTitle: () => title,
            applyTitle,
        });
        return {
            apply,
            applyTitle,
            setClaudeSessionId: (value: string | null) => { claudeSessionId = value; },
            setTitle: (value: string | null) => { title = value; },
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

    it('keeps the first applied title when Claude later renames the conversation', () => {
        const { apply, applyTitle } = setup();

        apply(event);
        apply({ ...event, aiTitle: 'Second title', sourceRevision: 'claude-session-1:Second title' });

        expect(applyTitle).toHaveBeenCalledTimes(1);
        expect(applyTitle).toHaveBeenCalledWith('Generated title');
    });

    it('treats a changed title as a new revision rather than a duplicate', () => {
        const { apply, applyTitle, setTitle } = setup();

        apply(event);
        // Title cleared out of band — the renamed observation must not be
        // swallowed by revision dedupe.
        setTitle(null);
        apply({ ...event, aiTitle: 'Second title', sourceRevision: 'claude-session-1:Second title' });

        expect(applyTitle).toHaveBeenCalledTimes(2);
        expect(applyTitle).toHaveBeenLastCalledWith('Second title');
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
