import { describe, expect, it } from 'vitest';
import {
    buildSessionFileRoute,
    decodeSessionFilePathParam,
    parseSessionFileLink,
    resolveSessionFilePath,
    splitSessionFileText,
} from './sessionFileLinks';
import { isFileMarkdownLink, parseFileMarkdownLink } from '@/components/markdown/linkUtils';

describe('sessionFileLinks', () => {
    const sessionRoot = '/Users/kirilldubovitskiy/projects/happy';

    it('parses absolute file refs with line numbers', () => {
        const result = parseSessionFileLink('/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts:594', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: null,
        });
    });

    it('parses relative file refs with line and column numbers', () => {
        const result = parseSessionFileLink('packages/happy-cli/src/codex/runCodex.ts:594:2', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: 'packages/happy-cli/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
            relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: 2,
        });
    });

    it('rejects external urls', () => {
        expect(parseSessionFileLink('https://openai.com', { sessionRoot })).toBeNull();
        expect(parseSessionFileLink('mailto:test@example.com', { sessionRoot })).toBeNull();
    });

    it('splits bare text into plain and linked segments', () => {
        const result = splitSessionFileText('Open packages/happy-cli/src/codex/runCodex.ts:594 please.', sessionRoot);

        expect(result).toEqual([
            { text: 'Open ', link: null },
            {
                text: 'packages/happy-cli/src/codex/runCodex.ts:594',
                link: {
                    path: 'packages/happy-cli/src/codex/runCodex.ts',
                    absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-cli/src/codex/runCodex.ts',
                    relativePath: 'packages/happy-cli/src/codex/runCodex.ts',
                    withinSessionRoot: true,
                    line: 594,
                    column: null,
                },
            },
            { text: ' please.', link: null },
        ]);
    });

    it('splits absolute bare file refs with spaces into linked segments', () => {
        const result = splitSessionFileText(
            'Image: /Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
            sessionRoot,
        );

        expect(result).toEqual([
            { text: 'Image: ', link: null },
            {
                text: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                link: {
                    path: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    absolutePath: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    relativePath: null,
                    withinSessionRoot: false,
                    line: null,
                    column: null,
                },
            },
        ]);
    });

    it('does not turn version numbers into file refs', () => {
        expect(splitSessionFileText('Version 1.2.3 shipped.', sessionRoot)).toEqual([
            { text: 'Version 1.2.3 shipped.', link: null },
        ]);
    });

    it('does not turn slash-separated prose into file refs', () => {
        expect(splitSessionFileText(
            'Codex then starts/resumes turns with backend default model. I’m checking CLI docs/tests to confirm there is intentionally no happy codex model set or --model surface today.',
            sessionRoot,
        )).toEqual([
            {
                text: 'Codex then starts/resumes turns with backend default model. I’m checking CLI docs/tests to confirm there is intentionally no happy codex model set or --model surface today.',
                link: null,
            },
        ]);
    });

    it('resolves viewer input to an absolute path', () => {
        expect(resolveSessionFilePath('packages/happy-app/README.md', sessionRoot)).toEqual({
            path: 'packages/happy-app/README.md',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-app/README.md',
            relativePath: 'packages/happy-app/README.md',
            withinSessionRoot: true,
            line: null,
            column: null,
        });
    });

    it('parses local file:// links with #L line ranges and rejects remote file authorities', () => {
        const parsed = parseFileMarkdownLink(
            'file:///Users/kirilldubovitskiy/projects/happy/packages/happy-app/sources/%EB%AC%B8%EC%84%9C/README.md#L12-L24',
            sessionRoot,
        );
        expect(parsed).toEqual({
            path: '/Users/kirilldubovitskiy/projects/happy/packages/happy-app/sources/문서/README.md',
            absolutePath: '/Users/kirilldubovitskiy/projects/happy/packages/happy-app/sources/문서/README.md',
            relativePath: 'packages/happy-app/sources/문서/README.md',
            withinSessionRoot: true,
            line: 12,
            column: null,
        });
        expect(isFileMarkdownLink('file://localhost/Users/kirilldubovitskiy/projects/happy/README.md#L3C7')).toBe(true);
        expect(parseFileMarkdownLink('file://attacker.example.com/share/secret.txt', sessionRoot)).toBeNull();
        expect(isFileMarkdownLink('https://example.com/file.md')).toBe(false);
    });

    it('round-trips UTF-8 Korean paths and legacy btoa ASCII paths for file screen routes', () => {
        const utf8Link = parseFileMarkdownLink(
            'file:///Users/kirilldubovitskiy/projects/happy/문서/가이드 (v2)+1.md#L42C3',
            sessionRoot,
        )!;
        const route = buildSessionFileRoute('sess-1', utf8Link);
        const url = new URL(route, 'https://happy.local');
        expect(url.pathname).toBe('/session/sess-1/file');
        expect(url.searchParams.get('line')).toBe('42');
        expect(url.searchParams.get('column')).toBe('3');
        expect(decodeSessionFilePathParam(url.searchParams.get('path') ?? '')).toBe(
            '/Users/kirilldubovitskiy/projects/happy/문서/가이드 (v2)+1.md',
        );
        expect(decodeSessionFilePathParam(btoa('/work/ascii/file.ts'))).toBe('/work/ascii/file.ts');
        expect(decodeSessionFilePathParam('Makefile')).toBe('Makefile');
        expect(decodeSessionFilePathParam('src/main')).toBe('src/main');
    });

    it('handles Windows percent-encoded drive letters, case-insensitive drive roots, explicit /auth file URLs, ~/ links, and rejects 4-slash UNC URLs', () => {
        const winLink = parseFileMarkdownLink(
            'file:///c%3A/Users/alice/project/src/index.ts#L10',
            'C:\\Users\\alice\\project',
        );
        expect(winLink).toEqual({
            path: 'C:/Users/alice/project/src/index.ts',
            absolutePath: 'C:/Users/alice/project/src/index.ts',
            relativePath: 'src/index.ts',
            withinSessionRoot: true,
            line: 10,
            column: null,
        });

        expect(parseFileMarkdownLink('file:///auth/index.ts', '/auth')?.withinSessionRoot).toBe(true);
        expect(isFileMarkdownLink('file:///~/notes/todo.md')).toBe(true);
        expect(parseFileMarkdownLink('file:////attacker.example.com/share/secret.txt', sessionRoot)).toBeNull();
        expect(resolveSessionFilePath('/work/snapshot:123', '/work', { literalPath: true })?.absolutePath).toBe('/work/snapshot:123');
    });
});
