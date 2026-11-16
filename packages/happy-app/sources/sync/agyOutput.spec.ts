import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';

// Public synthetic fixture only: no production conversation or tool output.
describe('AGY output through wire, normalization and reducer', () => {
    it.each([true, false])('preserves complete Markdown and tool error=%s', isError => {
        const markdown = '\n**Complete heading**\n\n```sh\nprintf "ok"\n```\n\n- one\n- two\n\n| 항목 | Alpha | Beta |\n| --- | --- | --- |\n| 방식 | **실시간** | 정적 |\n| 성능 | 보통 | 빠름 |\n';
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
        const table = parseMarkdown(text[0].text).find(block => block.type === 'table');
        expect(table?.type).toBe('table');
        if (table?.type === 'table') {
            expect(table.headers).toHaveLength(3);
            expect(table.rows).toHaveLength(2);
            expect(table.rows.every(row => row.length === 3)).toBe(true);
        }
        const tool = result.messages.find(message => message.kind === 'tool-call');
        expect(tool?.kind).toBe('tool-call');
        if (tool?.kind === 'tool-call') {
            expect(tool.tool.state).toBe(isError ? 'error' : 'completed');
            expect(tool.tool.result).toBe('Safe status.');
        }
    });

    it('upgrades Edit -> Write and replaces empty placeholder diffs on late tool-call updates and completedRequests', () => {
        const state = createReducer();
        const callId = 'clz000000000000000000001';

        // 1) Initial tool-call-start with empty placeholder diff followed by Write upgrade
        const start1 = normalizeRawMessage('db-1', null, 1, {
            role: 'agent',
            content: {
                type: 'session',
                data: createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: callId,
                    name: 'Edit',
                    title: 'Edit',
                    description: 'Running Edit',
                    args: { file_path: '/work/new.ts', old_string: '', new_string: '' },
                }, { turn: 'turn-1' }),
            },
        })!;
        const start2 = normalizeRawMessage('db-2', null, 2, {
            role: 'agent',
            content: {
                type: 'session',
                data: createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: callId,
                    name: 'Write',
                    title: 'Write',
                    description: 'Running Write',
                    args: { file_path: '/work/new.ts', content: 'export const ready = true;\n' },
                }, { turn: 'turn-1' }),
            },
        })!;

        reducer(state, [start1]);
        const updated = reducer(state, [start2]);
        const writeMsg = updated.messages.find(m => m.kind === 'tool-call');
        expect(writeMsg?.kind).toBe('tool-call');
        if (writeMsg?.kind === 'tool-call') {
            expect(writeMsg.tool.name).toBe('Write');
            expect(writeMsg.tool.input).toMatchObject({
                file_path: '/work/new.ts',
                content: 'export const ready = true;\n',
            });
        }

        // 2) Tool-call-start reduced before fast-approved completedRequests merges non-empty diff args
        const editCallId = 'clz000000000000000000002';
        const editStart = normalizeRawMessage('db-3', null, 3, {
            role: 'agent',
            content: {
                type: 'session',
                data: createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: editCallId,
                    name: 'Edit',
                    title: 'Edit',
                    description: 'Running Edit',
                    args: { file_path: '/work/app.ts' },
                }, { turn: 'turn-1' }),
            },
        })!;
        reducer(state, [editStart]);
        const withCompletedPerm = reducer(state, [], {
            requests: {},
            completedRequests: {
                [editCallId]: {
                    tool: 'Edit',
                    arguments: {
                        file_path: '/work/app.ts',
                        old_string: 'const x = 1;',
                        new_string: 'const x = 2;',
                    },
                    createdAt: 3,
                    completedAt: 4,
                    status: 'approved',
                    decision: 'approved',
                },
            },
        });
        const editMsg = withCompletedPerm.messages.find(m => m.kind === 'tool-call' && m.tool.callId === editCallId);
        expect(editMsg?.kind).toBe('tool-call');
        if (editMsg?.kind === 'tool-call') {
            expect(editMsg.tool.input).toEqual({
                file_path: '/work/app.ts',
                old_string: 'const x = 1;',
                new_string: 'const x = 2;',
            });
        }
    });
});
