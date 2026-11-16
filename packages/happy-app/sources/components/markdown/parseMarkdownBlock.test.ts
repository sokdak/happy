import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const spans = (text: string) => text ? [{ styles: [], text, url: null }] : [];

describe('parseMarkdownBlock - table parsing', () => {

    it('parses a standard table without blank lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')]],
        });
    });

    it('parses a table with blank lines between rows (LLM output)', () => {
        const md = [
            '| A | B |',
            '',
            '|---|---|',
            '',
            '| 1 | 2 |',
            '',
            '| 3 | 4 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        // Should be recognized as a single table, not 4 separate text blocks
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);
        expect(tableBlocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')], [spans('3'), spans('4')]],
        });
    });

    it('preserves empty interior cells (e.g. row header column)', () => {
        const md = [
            '| | Header1 | Header2 |',
            '|---|---|---|',
            '| Row1 | a | b |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans(''), spans('Header1'), spans('Header2')],
            rows: [[spans('Row1'), spans('a'), spans('b')]],
        });
    });

    it('handles blank lines and empty first cell combined', () => {
        const md = [
            '### Comparison',
            '',
            '| | Plan A | Plan B |',
            '',
            '|--|----|----|',
            '',
            '| Price | $10/mo | $20/mo |',
            '',
            '| Storage | 5 GB | 50 GB |',
            '',
            '| Support | Email only | 24/7 chat |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);

        const table = tableBlocks[0];
        if (table.type !== 'table') throw new Error('not a table');

        // Empty first cell should be preserved
        expect(table.headers).toHaveLength(3);
        expect(table.headers[0]).toEqual([]);

        expect(table.rows).toHaveLength(3);
        expect(table.rows[0][0]).toEqual(spans('Price'));
    });

    it('stops table collection at non-blank, non-pipe lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            'Some text after the table',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        const textBlocks = blocks.filter(b => b.type === 'text');

        expect(tableBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
    });
});

describe('parseMarkdownBlock - mixed nested lists and blockquotes/alerts', () => {
    it('keeps nested bullet items inside numbered lists across loose blank lines', () => {
        const md = [
            '1. **전원 확인**',
            '   - 입력 전압 측정',
            '   - 출력 단자 확인',
            '',
            '2. **배선 점검**',
            '   - 단락 여부 확인',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'numbered-list',
            items: [
                { number: 1, depth: 0, spans: [{ styles: ['bold'], text: '전원 확인', url: null }] },
                { depth: 1, spans: spans('입력 전압 측정') },
                { depth: 1, spans: spans('출력 단자 확인') },
                { number: 2, depth: 0, spans: [{ styles: ['bold'], text: '배선 점검', url: null }] },
                { depth: 1, spans: spans('단락 여부 확인') },
            ],
        });
    });

    it('keeps nested numbered items inside unordered lists while splitting top-level marker switches', () => {
        const md = [
            '- 준비물',
            '  1. 멀티미터',
            '  2. 절연 장갑',
            '',
            '1. 첫 단계',
            '2. 둘째 단계',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toEqual({
            type: 'list',
            items: [
                { depth: 0, spans: spans('준비물') },
                { number: 1, depth: 1, spans: spans('멀티미터') },
                { number: 2, depth: 1, spans: spans('절연 장갑') },
            ],
        });
        expect(blocks[1]).toEqual({
            type: 'numbered-list',
            items: [
                { number: 1, depth: 0, spans: spans('첫 단계') },
                { number: 2, depth: 0, spans: spans('둘째 단계') },
            ],
        });
    });

    it('parses standard blockquotes and both single-line and multi-line GitHub alerts', () => {
        const md = [
            '> 일반 인용문입니다.',
            '',
            '> [!WARNING] 고전압 주의가 필요합니다.',
            '',
            '> [!IMPORTANT]',
            '> 점검 순서:',
            '> - **`10A` 단자** 연결',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toEqual([
            {
                type: 'blockquote',
                alert: null,
                blocks: [
                    { type: 'text', content: spans('일반 인용문입니다.') },
                ],
            },
            {
                type: 'blockquote',
                alert: 'WARNING',
                blocks: [
                    { type: 'text', content: spans('고전압 주의가 필요합니다.') },
                ],
            },
            {
                type: 'blockquote',
                alert: 'IMPORTANT',
                blocks: [
                    { type: 'text', content: spans('점검 순서:') },
                    {
                        type: 'list',
                        items: [
                            {
                                depth: 0,
                                spans: [
                                    { styles: ['bold', 'code'], text: '10A', url: null },
                                    { styles: ['bold'], text: ' 단자', url: null },
                                    { styles: [], text: ' 연결', url: null },
                                ],
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it('stops table parsing before headings, lists, or union-typed prose containing pipes, and parses tables inside alerts', () => {
        const md = [
            '| Field | Type |',
            '|---|---|',
            '| id | string |',
            '',
            '### Returns `SessionFileLink | null`',
            '',
            '- Option `a | b`',
            '',
            '> [!NOTE]',
            '> | Pin | Voltage |',
            '> |---|---|',
            '> | VCC | 12V |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks.map(b => b.type)).toEqual(['table', 'header', 'list', 'blockquote']);
        const quote = blocks[3];
        if (quote?.type !== 'blockquote') throw new Error('Expected blockquote');
        expect(quote.alert).toBe('NOTE');
        expect(quote.blocks[0]?.type).toBe('table');
    });
});
