import type { MarkdownAlertKind, MarkdownBlock, MarkdownListItem, MarkdownSpan } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";

const MAX_BLOCKQUOTE_DEPTH = 5;
const GITHUB_ALERT_TAG = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i;

// Split a pipe-delimited table row into cells, stripping only the leading/trailing
// empty strings caused by outer pipes while preserving interior empty cells.
function splitTableRow(line: string): string[] {
    let cells = line.trim().split('|').map(cell => cell.trim());
    if (cells.length > 0 && cells[0] === '') cells = cells.slice(1);
    if (cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    return cells;
}

function parseTable(lines: string[], startIndex: number): { table: MarkdownBlock | null; nextIndex: number } {
    let index = startIndex;
    let lastConsumedIndex = startIndex;
    let sawBlankSinceLastRow = false;
    const tableLines: string[] = [];

    // Collect consecutive table lines while stopping at block boundaries (headings,
    // lists, blockquotes, fences, rules, or non-pipe-prefixed prose after a blank line).
    while (index < lines.length) {
        const rawLine = lines[index];
        const trimmedLine = rawLine.trim();
        if (trimmedLine === '') {
            sawBlankSinceLastRow = true;
            index++;
            continue;
        }
        if (
            trimmedLine.startsWith('>')
            || trimmedLine.startsWith('```')
            || trimmedLine.startsWith('<options>')
            || /^\s{0,3}#{1,6}\s+/.test(rawLine)
            || isHorizontalRule(trimmedLine)
            || matchListLine(rawLine) !== null
        ) {
            break;
        }
        if (!rawLine.includes('|')) {
            break;
        }
        // After a blank line following data rows, require an explicit leading pipe (`| ...`)
        // so prose containing `a | b` after a table is not absorbed as a table row.
        if (sawBlankSinceLastRow && tableLines.length >= 2 && !trimmedLine.startsWith('|')) {
            break;
        }
        tableLines.push(rawLine);
        sawBlankSinceLastRow = false;
        index++;
        lastConsumedIndex = index;
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    // Validate that the second line is a separator containing dashes, which distinguishes tables from plain text
    const separatorLine = tableLines[1].trim();
    const isSeparator = /^[|\s\-:=]*$/.test(separatorLine) && separatorLine.includes('-');

    if (!isSeparator) {
        return { table: null, nextIndex: startIndex };
    }

    const headers = splitTableRow(tableLines[0])
        .map(cell => parseMarkdownSpans(cell, false));

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    // Extract data rows from remaining lines (skipping the separator line)
    const rows: MarkdownSpan[][][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowCells = splitTableRow(tableLines[i])
            .map(cell => parseMarkdownSpans(cell, false));
        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows
    };

    return { table, nextIndex: lastConsumedIndex };
}

function getLeadingIndent(rawLine: string): number {
    let indent = 0;
    for (let i = 0; i < rawLine.length; i++) {
        if (rawLine[i] === ' ') {
            indent += 1;
        } else if (rawLine[i] === '\t') {
            indent += 4;
        } else {
            break;
        }
    }
    return indent;
}

type RawListLine =
    | { kind: 'ordered'; indent: number; number: number; content: string }
    | { kind: 'unordered'; indent: number; content: string };

function isHorizontalRule(trimmed: string): boolean {
    return /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed);
}

function matchListLine(rawLine: string): RawListLine | null {
    const trimmed = rawLine.trim();
    if (!trimmed || isHorizontalRule(trimmed)) {
        return null;
    }
    const indent = getLeadingIndent(rawLine);
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
        return {
            kind: 'ordered',
            indent,
            number: Number.parseInt(orderedMatch[1], 10),
            content: orderedMatch[2],
        };
    }
    const unorderedMatch = trimmed.match(/^([-*+])\s+(.*)$/);
    if (unorderedMatch) {
        return {
            kind: 'unordered',
            indent,
            content: unorderedMatch[2],
        };
    }
    return null;
}

function buildListItems(rawItems: RawListLine[], rootKind: 'ordered' | 'unordered'): MarkdownListItem[] {
    let baseIndent = rawItems[0].indent;
    for (const item of rawItems) {
        if (item.kind === rootKind && item.indent < baseIndent) {
            baseIndent = item.indent;
        }
    }

    const indentStack: number[] = [baseIndent];
    return rawItems.map((item) => {
        const effectiveIndent = Math.max(baseIndent, item.indent);
        while (indentStack.length > 1 && effectiveIndent < indentStack[indentStack.length - 1]) {
            indentStack.pop();
        }
        if (effectiveIndent - indentStack[indentStack.length - 1] >= 2) {
            indentStack.push(effectiveIndent);
        }
        const depth = indentStack.length - 1;
        const spans = parseMarkdownSpans(item.content, false);
        if (item.kind === 'ordered') {
            return { number: item.number, depth, spans };
        }
        return { depth, spans };
    });
}

function matchStandaloneImage(trimmed: string): { alt: string; url: string } | null {
    if (!trimmed.startsWith('![')) {
        return null;
    }
    const altEnd = trimmed.indexOf('](');
    if (altEnd === -1 || !trimmed.endsWith(')')) {
        return null;
    }
    const alt = trimmed.slice(2, altEnd);
    if (alt.includes('[')) {
        return null;
    }
    const innerUrl = trimmed.slice(altEnd + 2, -1);
    // Ensure balanced parentheses so `![a](u) text (more)` is not misclassified as a standalone image.
    let depth = 1;
    for (let i = 0; i < innerUrl.length; i++) {
        if (innerUrl[i] === '(') depth += 1;
        else if (innerUrl[i] === ')') {
            depth -= 1;
            if (depth === 0) {
                return null;
            }
        }
    }
    if (depth !== 1) {
        return null;
    }
    const url = innerUrl.trim();
    return url ? { alt, url } : null;
}

function parseMarkdownBlockInternal(markdown: string, quoteDepth: number): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let index = 0;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers (allow up to 3 leading spaces per CommonMark)
        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
            blocks.push({
                type: 'header',
                level,
                content: parseMarkdownSpans(headerMatch[2].trim(), true),
            });
            continue outer;
        }

        const trimmed = line.trim();

        // Code block
        if (trimmed.startsWith('```')) {
            const language = trimmed.slice(3).trim() || null;
            const content: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '```') {
                    index++;
                    break;
                }
                content.push(nextLine);
                index++;
            }
            const contentString = content.join('\n');

            // Detect mermaid diagram language and route to appropriate block type
            if (language === 'mermaid') {
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language, content: contentString });
            }
            continue;
        }

        // Horizontal rule
        if (isHorizontalRule(trimmed)) {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // Options block
        if (trimmed.startsWith('<options>')) {
            const items: string[] = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                if (nextLine.trim() === '</options>') {
                    index++;
                    break;
                }
                const optionMatch = nextLine.match(/<option>(.*?)<\/option>/);
                if (optionMatch) {
                    items.push(optionMatch[1]);
                }
                index++;
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            continue;
        }

        // Blockquotes & GitHub-style alerts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
        if (trimmed.startsWith('>') && quoteDepth < MAX_BLOCKQUOTE_DEPTH) {
            const quoteLines: string[] = [trimmed.replace(/^>\s?/, '')];
            while (index < lines.length) {
                const nextTrimmed = lines[index].trim();
                if (!nextTrimmed.startsWith('>')) {
                    break;
                }
                quoteLines.push(nextTrimmed.replace(/^>\s?/, ''));
                index++;
            }

            let alert: MarkdownAlertKind | null = null;
            const contentLines = [...quoteLines];
            const firstNonEmptyIdx = contentLines.findIndex(l => l.trim().length > 0);
            if (firstNonEmptyIdx !== -1) {
                const alertMatch = contentLines[firstNonEmptyIdx].trim().match(GITHUB_ALERT_TAG);
                if (alertMatch) {
                    alert = alertMatch[1].toUpperCase() as MarkdownAlertKind;
                    const inlineBody = alertMatch[2]?.trim() ?? '';
                    if (inlineBody) {
                        contentLines.splice(0, firstNonEmptyIdx + 1, inlineBody);
                    } else {
                        contentLines.splice(0, firstNonEmptyIdx + 1);
                    }
                }
            }

            const innerBlocks = parseMarkdownBlockInternal(contentLines.join('\n'), quoteDepth + 1);
            if (alert !== null || innerBlocks.length > 0) {
                blocks.push({
                    type: 'blockquote',
                    alert,
                    blocks: innerBlocks,
                });
            }
            continue;
        }

        // Standalone image block
        const imageMatch = matchStandaloneImage(trimmed);
        if (imageMatch) {
            blocks.push({ type: 'image', alt: imageMatch.alt, url: imageMatch.url });
            continue;
        }

        // Lists (ordered, unordered, and mixed nested sublists)
        const firstListItem = matchListLine(line);
        if (firstListItem) {
            const rootKind = firstListItem.kind;
            const baseIndent = firstListItem.indent;
            const rawItems: RawListLine[] = [firstListItem];

            while (index < lines.length) {
                let peek = index;
                while (peek < lines.length && lines[peek].trim() === '') {
                    peek++;
                }
                if (peek >= lines.length) {
                    break;
                }
                const nextItem = matchListLine(lines[peek]);
                if (!nextItem) {
                    break;
                }
                // Switching marker type at root indentation starts a separate list block,
                // while indented sub-items (nextItem.indent > baseIndent) nest inside this list.
                if (nextItem.indent <= baseIndent && nextItem.kind !== rootKind) {
                    break;
                }
                rawItems.push(nextItem);
                index = peek + 1;
            }

            const items = buildListItems(rawItems, rootKind);
            blocks.push({
                type: rootKind === 'ordered' ? 'numbered-list' : 'list',
                items,
            });
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}

export function parseMarkdownBlock(markdown: string): MarkdownBlock[] {
    return parseMarkdownBlockInternal(markdown, 0);
}
