import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const item = (spans: { styles: string[]; text: string; url: string | null }[]) => ({
    depth: 0,
    spans,
});

describe('parseMarkdown', () => {
    it('parses unordered lists across common markdown bullet markers and preserves clickable links', () => {
        const blocks = parseMarkdown([
            '* first item',
            '+ second item with [docs](https://example.com/docs)',
            '- third item with https://example.com/raw.',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('list');

        if (blocks[0]?.type !== 'list') {
            throw new Error('Expected markdown list block');
        }

        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[1]).toEqual(item([
            { styles: [], text: 'second item with ', url: null },
            { styles: [], text: 'docs', url: 'https://example.com/docs' },
        ]));
        expect(blocks[0].items[2]).toEqual(item([
            { styles: [], text: 'third item with ', url: null },
            { styles: [], text: 'https://example.com/raw', url: 'https://example.com/raw' },
            { styles: [], text: '.', url: null },
        ]));
    });

    it('parses standalone markdown image blocks', () => {
        const blocks = parseMarkdown('![Markdown renderable image](data:image/png;base64,abc123)');

        expect(blocks).toEqual([
            {
                type: 'image',
                alt: 'Markdown renderable image',
                url: 'data:image/png;base64,abc123',
            },
        ]);
    });

    it('auto-linkifies bare URLs in text blocks', () => {
        const blocks = parseMarkdown('Visit https://example.com/docs for more.');

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('text');

        if (blocks[0]?.type !== 'text') {
            throw new Error('Expected markdown text block');
        }

        expect(blocks[0].content).toEqual([
            { styles: [], text: 'Visit ', url: null },
            { styles: [], text: 'https://example.com/docs', url: 'https://example.com/docs' },
            { styles: [], text: ' for more.', url: null },
        ]);
    });

    it('recursively parses inline code and links nested inside bold and italic spans', () => {
        const blocks = parseMarkdown('반드시 **`LED+`와 `LED-`** 및 **`10A` 단자**를 확인하고 *`COM` 기준*으로 측정하세요.');

        expect(blocks).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: '반드시 ', url: null },
                    { styles: ['bold', 'code'], text: 'LED+', url: null },
                    { styles: ['bold'], text: '와 ', url: null },
                    { styles: ['bold', 'code'], text: 'LED-', url: null },
                    { styles: [], text: ' 및 ', url: null },
                    { styles: ['bold', 'code'], text: '10A', url: null },
                    { styles: ['bold'], text: ' 단자', url: null },
                    { styles: [], text: '를 확인하고 ', url: null },
                    { styles: ['italic', 'code'], text: 'COM', url: null },
                    { styles: ['italic'], text: ' 기준', url: null },
                    { styles: [], text: '으로 측정하세요.', url: null },
                ],
            },
        ]);
    });

    it('parses file:// and http links containing balanced parentheses and styled labels', () => {
        const blocks = parseMarkdown([
            '참고: [인계 진입점 (README.md)](file:///home/blupine/work/README.md#L10-L20)',
            '라우트: [`file.tsx`](file:///home/blupine/app/(app)/session/[id]/file.tsx#L85)',
            '위키: (https://en.wikipedia.org/wiki/Rust_(programming_language))',
        ].join('\n'));

        expect(blocks).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: '참고: ', url: null },
                    {
                        styles: [],
                        text: '인계 진입점 (README.md)',
                        url: 'file:///home/blupine/work/README.md#L10-L20',
                    },
                ],
            },
            {
                type: 'text',
                content: [
                    { styles: [], text: '라우트: ', url: null },
                    {
                        styles: ['code'],
                        text: 'file.tsx',
                        url: 'file:///home/blupine/app/(app)/session/[id]/file.tsx#L85',
                    },
                ],
            },
            {
                type: 'text',
                content: [
                    { styles: [], text: '위키: (', url: null },
                    {
                        styles: [],
                        text: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
                        url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
                    },
                    { styles: [], text: ')', url: null },
                ],
            },
        ]);
    });

    it('preserves multiplication asterisks and glob wildcards while stripping emphasis inside headers', () => {
        const blocks = parseMarkdown([
            '### **`12V` 출력** 점검',
            '전력 계산: 12V * 2A = 24W (대상 파일: *.ts)',
        ].join('\n'));

        expect(blocks).toEqual([
            {
                type: 'header',
                level: 3,
                content: [
                    { styles: ['code'], text: '12V', url: null },
                    { styles: [], text: ' 출력 점검', url: null },
                ],
            },
            {
                type: 'text',
                content: [
                    { styles: [], text: '전력 계산: 12V * 2A = 24W (대상 파일: *.ts)', url: null },
                ],
            },
        ]);
    });

    it('handles pathological unclosed delimiters in linear time (< 50ms) and preserves code subscript calls, escapes, globstars, and link titles', () => {
        const startedAt = performance.now();
        parseMarkdown('*a '.repeat(1500) + '[x'.repeat(1500));
        parseMarkdown('['.repeat(5000));
        parseMarkdown('[a]('.repeat(5000));
        parseMarkdown('https://a.co/' + ')'.repeat(5000));
        expect(performance.now() - startedAt).toBeLessThan(100);

        expect(parseMarkdown('Calling handlers[idx](arg1, fn(arg2)) and fn[0](foo.bar) failed')).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: 'Calling handlers[idx](arg1, fn(arg2)) and fn[0](foo.bar) failed', url: null },
                ],
            },
        ]);

        expect(parseMarkdown('Check src/**/*.ts and lib/**/*.ts')).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: 'Check src/**/*.ts and lib/**/*.ts', url: null },
                ],
            },
        ]);

        expect(parseMarkdown('Check src/**/*.ts and **important** with [spec](<https://example.com/a)b>) and **read**/write')).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: 'Check src/**/*.ts and ', url: null },
                    { styles: ['bold'], text: 'important', url: null },
                    { styles: [], text: ' with ', url: null },
                    { styles: [], text: 'spec', url: 'https://example.com/a)b' },
                    { styles: [], text: ' and ', url: null },
                    { styles: ['bold'], text: 'read', url: null },
                    { styles: [], text: '/write', url: null },
                ],
            },
        ]);

        expect(parseMarkdown('Escaped \\*literal\\* and \\[not-link\\](https://x.test) vs [Docs](https://example.com/docs "Guide") and [a](file:///work/a\\(1\\).md)')).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: 'Escaped *literal* and [not-link](', url: null },
                    { styles: [], text: 'https://x.test', url: 'https://x.test' },
                    { styles: [], text: ') vs ', url: null },
                    { styles: [], text: 'Docs', url: 'https://example.com/docs' },
                    { styles: [], text: ' and ', url: null },
                    { styles: [], text: 'a', url: 'file:///work/a(1).md' },
                ],
            },
        ]);

        expect(parseMarkdown('**bold *italic***')).toEqual([
            {
                type: 'text',
                content: [
                    { styles: ['bold'], text: 'bold ', url: null },
                    { styles: ['bold', 'italic'], text: 'italic', url: null },
                ],
            },
        ]);
    });
});
