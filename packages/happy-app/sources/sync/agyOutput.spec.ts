import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

// Public synthetic fixture only: no production conversation or tool output.
describe('AGY output through wire, normalization and reducer', () => {
    it.each([true, false])('preserves complete Markdown and tool error=%s', isError => {
        const markdown = '\n**Complete heading**\n\n```sh\nprintf "ok"\n```\n\n- one\n- two\n';
        const events = [
            createEnvelope('agent', { t: 'text', text: markdown }, { turn: 'turn-1' }),
            createEnvelope('agent', { t: 'tool-call-start', call: 'call-1', name: 'Bash', title: 'Command', description: 'Run command', args: { command: 'true' } }, { turn: 'turn-1' }),
            createEnvelope('agent', { t: 'tool-call-end', call: 'call-1', result: 'Safe status.', isError }, { turn: 'turn-1' }),
        ];
        const normalized = events.map((data, i) => normalizeRawMessage(`db-${i}`, null, i + 1, {
            role: 'agent', content: { type: 'session', data },
        })).filter((message): message is NonNullable<typeof message> => message !== null);
        const result = reducer(createReducer(), normalized);
        const text = result.messages.filter(message => message.kind === 'agent-text');
        expect(text).toHaveLength(1);
        expect(text[0].text).toBe(markdown);
        const tool = result.messages.find(message => message.kind === 'tool-call');
        expect(tool?.kind).toBe('tool-call');
        if (tool?.kind === 'tool-call') {
            expect(tool.tool.state).toBe(isError ? 'error' : 'completed');
            expect(tool.tool.result).toBe('Safe status.');
        }
    });
});
