import { parseMarkdownBlock } from "./parseMarkdownBlock"

export type MarkdownAlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export type MarkdownListItem = {
    depth: number;
    spans: MarkdownSpan[];
    number?: number;
};

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: MarkdownListItem[]
} | {
    type: 'numbered-list',
    items: MarkdownListItem[]
} | {
    type: 'blockquote',
    alert: MarkdownAlertKind | null,
    blocks: MarkdownBlock[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'table',
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][]
} | {
    type: 'image',
    alt: string,
    url: string
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code')[],
    text: string,
    url: string | null
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}
