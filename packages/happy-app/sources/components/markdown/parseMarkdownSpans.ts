import type { MarkdownSpan } from "./parseMarkdown";

// Note: Underscore emphasis (`_italic_` / `__bold__`) is intentionally omitted so
// `snake_case` identifiers and file names in technical prose never corrupt into italics.

type SpanStyle = MarkdownSpan['styles'][number];

const ESCAPABLE_ASCII_PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const BARE_FILE_TARGET = /^[A-Za-z0-9._-]+\.[A-Za-z]{1,10}(?:[:#]\S+)?$/;

function sameStyles(a: SpanStyle[], b: SpanStyle[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function addStyle(styles: SpanStyle[], style: SpanStyle): SpanStyle[] {
    return styles.includes(style) ? styles : [...styles, style];
}

function pushSpan(spans: MarkdownSpan[], span: MarkdownSpan) {
    if (!span.text) return;
    const last = spans[spans.length - 1];
    if (last && last.url === span.url && sameStyles(last.styles, span.styles)) {
        last.text += span.text;
        return;
    }
    spans.push({ styles: [...span.styles], text: span.text, url: span.url });
}

function countChar(value: string, ch: string): number {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === ch) count += 1;
    }
    return count;
}

function pushTextWithAutoLinks(spans: MarkdownSpan[], text: string, styles: SpanStyle[]) {
    const urlPattern = /https?:\/\/[^\s<]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(text)) !== null) {
        const plainText = text.slice(lastIndex, match.index);
        if (plainText) {
            pushSpan(spans, { styles, text: plainText, url: null });
        }

        let url = match[0];
        let trailing = '';
        const openParens = countChar(url, '(');
        let closeParens = countChar(url, ')');
        while (url.length > 0) {
            const lastChar = url[url.length - 1];
            if (/[.,;:!?]/.test(lastChar)) {
                trailing = lastChar + trailing;
                url = url.slice(0, -1);
                continue;
            }
            if (lastChar === ')' && closeParens > openParens) {
                trailing = lastChar + trailing;
                url = url.slice(0, -1);
                closeParens -= 1;
                continue;
            }
            break;
        }

        if (url) {
            pushSpan(spans, { styles, text: url, url });
        }
        if (trailing) {
            pushSpan(spans, { styles, text: trailing, url: null });
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        pushSpan(spans, { styles, text: text.slice(lastIndex), url: null });
    }
}

function pushPlainText(spans: MarkdownSpan[], text: string, styles: SpanStyle[], url: string | null) {
    if (!text) return;
    if (url !== null) {
        pushSpan(spans, { styles, text, url });
        return;
    }
    pushTextWithAutoLinks(spans, text, styles);
}

type LinkMatch = {
    label: string;
    url: string;
    endIndex: number;
};

type InlineIndex = {
    codeClose: Map<number, number>;
    matchingBracket: Map<number, number>;
    matchingParen: Map<number, number>;
    links: Map<number, LinkMatch | null>;
};

function findClosingBackticksWithCache(
    text: string,
    startIndex: number,
    tickCount: number,
    unclosedFromByLen: Map<number, number>,
): number {
    const failFloor = unclosedFromByLen.get(tickCount);
    if (failFloor !== undefined && startIndex >= failFloor) {
        return -1;
    }
    const target = '`'.repeat(tickCount);
    let i = startIndex;
    while (i <= text.length - tickCount) {
        const idx = text.indexOf(target, i);
        if (idx === -1) {
            unclosedFromByLen.set(tickCount, startIndex);
            return -1;
        }
        const prevIsTick = idx > 0 && text[idx - 1] === '`';
        const nextIsTick = idx + tickCount < text.length && text[idx + tickCount] === '`';
        if (!prevIsTick && !nextIsTick) {
            return idx;
        }
        i = idx + 1;
    }
    unclosedFromByLen.set(tickCount, startIndex);
    return -1;
}

/**
 * Single linear-time pass to index code spans, matching `[` -> `]`, and matching `(` -> `)`
 * so pathological inputs like `'['.repeat(5000)` or `'*a '.repeat(1500) + '[x'.repeat(1500)`
 * never trigger quadratic or cubic rescanning on the UI thread.
 */
function buildInlineIndex(text: string): InlineIndex {
    const codeClose = new Map<number, number>();
    const matchingBracket = new Map<number, number>();
    const matchingParen = new Map<number, number>();
    const unclosedFromByLen = new Map<number, number>();
    const bracketStack: number[] = [];
    const parenStack: number[] = [];

    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            i += 2;
            continue;
        }
        if (ch === '`') {
            let j = i;
            while (j < text.length && text[j] === '`') j++;
            const tickCount = j - i;
            const closeIdx = findClosingBackticksWithCache(text, j, tickCount, unclosedFromByLen);
            if (closeIdx !== -1) {
                codeClose.set(i, closeIdx);
                i = closeIdx + tickCount;
                continue;
            }
            if (tickCount === 1) {
                codeClose.set(i, text.length);
                break;
            }
            i = j;
            continue;
        }
        if (ch === '[') {
            bracketStack.push(i);
        } else if (ch === ']') {
            const open = bracketStack.pop();
            if (open !== undefined) {
                matchingBracket.set(open, i);
            }
        } else if (ch === '(') {
            parenStack.push(i);
        } else if (ch === ')') {
            const open = parenStack.pop();
            if (open !== undefined) {
                matchingParen.set(open, i);
            }
        } else if (ch === '\n' || ch === '\r') {
            parenStack.length = 0;
        }
        i += 1;
    }

    return {
        codeClose,
        matchingBracket,
        matchingParen,
        links: new Map(),
    };
}

function skipIndexedCodeSpan(text: string, index: number, inlineIndex: InlineIndex): number {
    let j = index;
    while (j < text.length && text[j] === '`') j++;
    const tickCount = j - index;
    const closeIdx = inlineIndex.codeClose.get(index);
    if (closeIdx !== undefined) {
        return closeIdx === text.length ? text.length : closeIdx + tickCount;
    }
    return j;
}

function unescapeLinkDestination(raw: string): string {
    return raw.replace(/\\([()\\"'<> ])/g, '$1');
}

function isPlausibleMarkdownLinkUrl(
    text: string,
    startIndex: number,
    url: string,
    angleBracketed: boolean,
): boolean {
    if (!url || /[\r\n\0]/.test(url)) {
        return false;
    }
    if (angleBracketed) {
        return true;
    }
    if (URL_SCHEME_PREFIX.test(url)) {
        if (/^file:\/\//i.test(url)) {
            return true;
        }
        return !/\s/.test(url);
    }
    // Prevent subscript + call expressions like `handlers[idx](arg1, fn(arg2))` or `fn[0](foo.bar)`
    // from being misparsed as Markdown links when immediately preceded by an identifier/indexer token.
    if (
        startIndex > 0
        && /[A-Za-z0-9_$\])]/.test(text[startIndex - 1])
        && !/^(?:\/|\.{1,2}\/|~\/|#)/.test(url)
    ) {
        return false;
    }
    if (/^#\S+$/.test(url)) {
        return true;
    }
    if (/[\s,]/.test(url)) {
        return false;
    }
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('~/') || url.includes('/')) {
        return true;
    }
    return BARE_FILE_TARGET.test(url);
}

function matchMarkdownLink(text: string, startIndex: number, inlineIndex: InlineIndex): LinkMatch | null {
    if (text[startIndex] !== '[') return null;
    if (inlineIndex.links.has(startIndex)) {
        return inlineIndex.links.get(startIndex)!;
    }

    const fail = (): null => {
        inlineIndex.links.set(startIndex, null);
        return null;
    };

    const closeBracket = inlineIndex.matchingBracket.get(startIndex);
    if (closeBracket === undefined || closeBracket === startIndex + 1) {
        return fail();
    }

    const openParen = closeBracket + 1;
    if (openParen >= text.length || text[openParen] !== '(') {
        return fail();
    }

    // Handle angle-bracket link destinations `[label](<url with ) or (> "Optional Title")`
    // before consulting `matchingParen` so unbalanced parens inside `<...>` are allowed per CommonMark.
    let afterOpenWs = openParen + 1;
    while (afterOpenWs < text.length && (text[afterOpenWs] === ' ' || text[afterOpenWs] === '\t')) {
        afterOpenWs += 1;
    }
    if (afterOpenWs < text.length && text[afterOpenWs] === '<') {
        let angleScan = afterOpenWs + 1;
        let closeAngle = -1;
        while (angleScan < text.length) {
            if (text[angleScan] === '\r' || text[angleScan] === '\n' || text[angleScan] === '<') {
                break;
            }
            if (text[angleScan] === '\\' && angleScan + 1 < text.length) {
                angleScan += 2;
                continue;
            }
            if (text[angleScan] === '>') {
                closeAngle = angleScan;
                break;
            }
            angleScan += 1;
        }
        if (closeAngle !== -1) {
            const afterAngleMatch = text
                .slice(closeAngle + 1)
                .match(/^[ \t]*(?:(?:"[^"\r\n]*"|'[^'\r\n]*')[ \t]*)?\)/);
            if (afterAngleMatch) {
                const url = unescapeLinkDestination(text.slice(afterOpenWs + 1, closeAngle).trim());
                if (!isPlausibleMarkdownLinkUrl(text, startIndex, url, true)) {
                    return fail();
                }
                const hit: LinkMatch = {
                    label: text.slice(startIndex + 1, closeBracket),
                    url,
                    endIndex: closeAngle + 1 + afterAngleMatch[0].length,
                };
                inlineIndex.links.set(startIndex, hit);
                return hit;
            }
        }
    }

    const closeParen = inlineIndex.matchingParen.get(openParen);
    if (closeParen === undefined) {
        return fail();
    }

    const rawSlice = text.slice(openParen + 1, closeParen).trim();
    if (!rawSlice || /[\r\n]/.test(rawSlice)) {
        return fail();
    }

    const withoutTitleMatch = rawSlice.match(/^(.*?)\s+(?:"[^"\r\n]*"|'[^'\r\n]*')$/);
    const rawUrl = (withoutTitleMatch ? withoutTitleMatch[1] : rawSlice).trim();
    const url = unescapeLinkDestination(rawUrl);
    if (!isPlausibleMarkdownLinkUrl(text, startIndex, url, false)) {
        return fail();
    }

    const hit: LinkMatch = {
        label: text.slice(startIndex + 1, closeBracket),
        url,
        endIndex: closeParen + 1,
    };
    inlineIndex.links.set(startIndex, hit);
    return hit;
}

function isGlobstarDelimiter(text: string, index: number): boolean {
    if (index > 0 && text[index - 1] === '/') {
        return true;
    }
    return (index === 0 || /[\s([{"'<]/.test(text[index - 1]))
        && index + 2 < text.length
        && text[index + 2] === '/';
}

function hasUnpairedSingleStar(
    text: string,
    startIndex: number,
    endIndex: number,
    inlineIndex: InlineIndex,
): boolean {
    let count = 0;
    let i = startIndex;
    while (i < endIndex) {
        if (text[i] === '\\' && i + 1 < endIndex) {
            i += 2;
            continue;
        }
        if (text[i] === '`') {
            i = Math.min(endIndex, skipIndexedCodeSpan(text, i, inlineIndex));
            continue;
        }
        if (text.startsWith('**', i)) {
            i += 2;
            continue;
        }
        if (text[i] === '*' && !isPathWildcardStar(text, i)) {
            count += 1;
        }
        i += 1;
    }
    return count % 2 === 1;
}

function findClosingDelimiter(
    text: string,
    startIndex: number,
    delimiter: '***' | '**',
    allowLinks: boolean,
    inlineIndex: InlineIndex,
): number {
    let i = startIndex;
    while (i <= text.length - delimiter.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
            i += 2;
            continue;
        }
        if (text[i] === '`') {
            i = skipIndexedCodeSpan(text, i, inlineIndex);
            continue;
        }
        if (allowLinks && text[i] === '[') {
            const link = matchMarkdownLink(text, i, inlineIndex);
            if (link) {
                i = link.endIndex;
                continue;
            }
        }
        if (delimiter === '**' && isGlobstarDelimiter(text, i)) {
            i += 2;
            continue;
        }
        if (delimiter === '**' && text.startsWith('***', i)) {
            // Support `**bold *italic***`: let the first `*` close the inner italic
            // and the remaining `**` close the outer bold.
            if (hasUnpairedSingleStar(text, startIndex, i, inlineIndex)) {
                return i + 1;
            }
            return i;
        }
        if (text.startsWith(delimiter, i)) {
            return i;
        }
        i += 1;
    }
    return -1;
}

function isPathWildcardStar(text: string, index: number): boolean {
    if (index > 0 && text[index - 1] === '/') {
        return true;
    }
    return /^\*\.[A-Za-z0-9_-]+\b/.test(text.slice(index));
}

function findClosingSingleStar(
    text: string,
    startIndex: number,
    allowLinks: boolean,
    inlineIndex: InlineIndex,
): number {
    let i = startIndex;
    while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
            i += 2;
            continue;
        }
        if (text[i] === '`') {
            i = skipIndexedCodeSpan(text, i, inlineIndex);
            continue;
        }
        if (allowLinks && text[i] === '[') {
            const link = matchMarkdownLink(text, i, inlineIndex);
            if (link) {
                i = link.endIndex;
                continue;
            }
        }
        if (text.startsWith('**', i)) {
            const closeDouble = findClosingDelimiter(text, i + 2, '**', allowLinks, inlineIndex);
            if (closeDouble !== -1) {
                i = closeDouble + 2;
                continue;
            }
            i += 2;
            continue;
        }
        if (text[i] === '*' && i > startIndex && !/\s/.test(text[i - 1]) && !isPathWildcardStar(text, i)) {
            return i;
        }
        i += 1;
    }
    return -1;
}

function scanInline(
    text: string,
    header: boolean,
    inheritedStyles: SpanStyle[],
    inheritedUrl: string | null,
    allowLinks: boolean,
    spans: MarkdownSpan[],
) {
    if (!text) return;
    const inlineIndex = buildInlineIndex(text);
    let plainStart = 0;
    let i = 0;
    let noTripleCloseFrom = Infinity;
    let noDoubleCloseFrom = Infinity;
    let noSingleCloseFrom = Infinity;

    const flushPlain = (end: number) => {
        if (end > plainStart) {
            pushPlainText(spans, text.slice(plainStart, end), inheritedStyles, inheritedUrl);
        }
    };

    while (i < text.length) {
        const ch = text[i];

        // 0. Backslash-escaped ASCII punctuation (`\*`, `\[`, `\(`, `\\`, etc.)
        if (ch === '\\' && i + 1 < text.length && ESCAPABLE_ASCII_PUNCTUATION.test(text[i + 1])) {
            flushPlain(i);
            pushSpan(spans, {
                styles: inheritedStyles,
                text: text[i + 1],
                url: inheritedUrl,
            });
            i += 2;
            plainStart = i;
            continue;
        }

        // 1. Inline code (`...` or ``...``)
        if (ch === '`') {
            let j = i;
            while (j < text.length && text[j] === '`') j++;
            const tickCount = j - i;
            const closeIdx = inlineIndex.codeClose.get(i);
            if (closeIdx !== undefined && closeIdx < text.length) {
                flushPlain(i);
                const rawCode = text.slice(j, closeIdx);
                const normalizedCode = tickCount > 1
                    && rawCode.length >= 2
                    && rawCode.startsWith(' ')
                    && rawCode.endsWith(' ')
                    && rawCode.trim().length > 0
                    ? rawCode.slice(1, -1)
                    : rawCode;
                pushSpan(spans, {
                    styles: addStyle(inheritedStyles, 'code'),
                    text: normalizedCode,
                    url: inheritedUrl,
                });
                i = closeIdx + tickCount;
                plainStart = i;
                continue;
            }
            if (closeIdx === text.length && tickCount === 1) {
                flushPlain(i);
                pushSpan(spans, {
                    styles: addStyle(inheritedStyles, 'code'),
                    text: text.slice(j),
                    url: inheritedUrl,
                });
                i = text.length;
                plainStart = i;
                break;
            }
            i = j;
            continue;
        }

        // 2. Markdown link [label](url)
        if (allowLinks && ch === '[') {
            const link = matchMarkdownLink(text, i, inlineIndex);
            if (link) {
                flushPlain(i);
                scanInline(link.label, header, inheritedStyles, link.url, false, spans);
                i = link.endIndex;
                plainStart = i;
                continue;
            }
        }

        // 3. Emphasis (***bold italic***, **bold**, *italic*)
        if (ch === '*') {
            if (
                i < noTripleCloseFrom
                && text.startsWith('***', i)
                && i + 3 < text.length
                && !/\s/.test(text[i + 3])
            ) {
                const closeIdx = findClosingDelimiter(text, i + 3, '***', allowLinks, inlineIndex);
                if (closeIdx === -1) {
                    noTripleCloseFrom = i;
                } else if (closeIdx > i + 3) {
                    flushPlain(i);
                    const nextStyles = header
                        ? inheritedStyles
                        : addStyle(addStyle(inheritedStyles, 'bold'), 'italic');
                    scanInline(text.slice(i + 3, closeIdx), header, nextStyles, inheritedUrl, allowLinks, spans);
                    i = closeIdx + 3;
                    plainStart = i;
                    continue;
                }
            }

            if (text.startsWith('**', i)) {
                if (isGlobstarDelimiter(text, i)) {
                    i += 2;
                    continue;
                }
                const closeIdx = i < noDoubleCloseFrom
                    ? findClosingDelimiter(text, i + 2, '**', allowLinks, inlineIndex)
                    : -1;
                if (closeIdx === -1 && i < noDoubleCloseFrom) {
                    noDoubleCloseFrom = i;
                }
                if (closeIdx !== -1) {
                    flushPlain(i);
                    if (closeIdx > i + 2) {
                        const nextStyles = header ? inheritedStyles : addStyle(inheritedStyles, 'bold');
                        scanInline(text.slice(i + 2, closeIdx), header, nextStyles, inheritedUrl, allowLinks, spans);
                    }
                    i = closeIdx + 2;
                    plainStart = i;
                    continue;
                }
                if (i + 2 < text.length && !/\s/.test(text[i + 2])) {
                    flushPlain(i);
                    const nextStyles = header ? inheritedStyles : addStyle(inheritedStyles, 'bold');
                    scanInline(text.slice(i + 2), header, nextStyles, inheritedUrl, allowLinks, spans);
                    i = text.length;
                    plainStart = i;
                    break;
                }
                i += 2;
                continue;
            } else if (
                i < noSingleCloseFrom
                && i + 1 < text.length
                && !/\s/.test(text[i + 1])
                && !isPathWildcardStar(text, i)
            ) {
                const closeIdx = findClosingSingleStar(text, i + 1, allowLinks, inlineIndex);
                if (closeIdx === -1) {
                    noSingleCloseFrom = i;
                } else {
                    flushPlain(i);
                    const nextStyles = header ? inheritedStyles : addStyle(inheritedStyles, 'italic');
                    scanInline(text.slice(i + 1, closeIdx), header, nextStyles, inheritedUrl, allowLinks, spans);
                    i = closeIdx + 1;
                    plainStart = i;
                    continue;
                }
            }
        }

        i += 1;
    }

    flushPlain(text.length);
}

export function parseMarkdownSpans(markdown: string, header: boolean): MarkdownSpan[] {
    const spans: MarkdownSpan[] = [];
    scanInline(markdown, header, [], null, true, spans);
    return spans;
}
