import { parseSessionFileLink, type SessionFileLink } from '@/utils/sessionFileLinks';

const HTTP_URL_PATTERN = /^https?:\/\//i;
const FILE_URL_PATTERN = /^file:\/\//i;

export function isHttpMarkdownLink(url: string): boolean {
    return HTTP_URL_PATTERN.test(url.trim());
}

export function parseFileMarkdownLink(url: string, sessionRoot?: string | null): SessionFileLink | null {
    const trimmed = url.trim();
    if (!FILE_URL_PATTERN.test(trimmed)) {
        return null;
    }
    return parseSessionFileLink(trimmed, { sessionRoot });
}

export function isFileMarkdownLink(url: string): boolean {
    return parseFileMarkdownLink(url) !== null;
}
