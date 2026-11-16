import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export type SessionFileLink = {
    path: string;
    absolutePath: string;
    relativePath: string | null;
    withinSessionRoot: boolean;
    line: number | null;
    column: number | null;
};

export type SessionFileTextSegment = {
    text: string;
    link: SessionFileLink | null;
};

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const POSIX_ABSOLUTE_PATH = /^\//;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FILE_URL_PREFIX = /^file:\/\//i;
const LINE_FRAGMENT = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i;
const RELATIVE_PREFIX = /^(?:\.{1,2}[\\/]|~[\\/])/;
const HAS_PATH_SEPARATOR = /[\\/]/;
const BARE_FILE_NAME = /^[^\\/\s]+\.[^\\/\s]+$/;
const NUMERIC_EXTENSION = /^\d+$/;
const FILE_EXTENSION = /^[A-Za-z0-9_-]{1,16}$/;
const EXTENSIONLESS_FILE_NAMES = new Set([
    'README',
    'LICENSE',
    'Makefile',
    'Dockerfile',
    '.gitignore',
    '.gitattributes',
    '.env',
    '.npmrc',
    '.yarnrc',
]);
const LEADING_WRAP = /^[([{<"'`]+/;
const TRAILING_WRAP = /[)\]}>",;!?`]+$/;
const APP_ROUTE_PREFIXES = ['/session/', '/text-selection', '/settings', '/auth'];

function parseLineAndColumn(value: string): { path: string; line: number | null; column: number | null } {
    const trimmed = value.trim();
    const lineColumnMatch = trimmed.match(/^(.*):(\d+):(\d+)$/);
    if (lineColumnMatch) {
        return {
            path: lineColumnMatch[1],
            line: Number.parseInt(lineColumnMatch[2], 10),
            column: Number.parseInt(lineColumnMatch[3], 10),
        };
    }

    const lineMatch = trimmed.match(/^(.*):(\d+)$/);
    if (!lineMatch) {
        return {
            path: trimmed,
            line: null,
            column: null,
        };
    }

    return {
        path: lineMatch[1],
        line: Number.parseInt(lineMatch[2], 10),
        column: null,
    };
}

function pushTextSegment(segments: SessionFileTextSegment[], text: string) {
    if (!text) {
        return;
    }
    const last = segments[segments.length - 1];
    if (last && last.link === null) {
        last.text += text;
        return;
    }
    segments.push({ text, link: null });
}

function stripToken(value: string): { leading: string; core: string; trailing: string } {
    const leading = value.match(LEADING_WRAP)?.[0] ?? '';
    const withoutLeading = leading ? value.slice(leading.length) : value;
    const trailing = withoutLeading.match(TRAILING_WRAP)?.[0] ?? '';
    const core = trailing ? withoutLeading.slice(0, withoutLeading.length - trailing.length) : withoutLeading;
    return { leading, core, trailing };
}

function parseFileUrlTarget(value: string): { path: string; line: number | null; column: number | null } | null {
    const trimmed = value.trim();
    if (!FILE_URL_PREFIX.test(trimmed)) {
        return null;
    }

    const remainder = trimmed.replace(FILE_URL_PREFIX, '');
    const hashIndex = remainder.indexOf('#');
    const withoutHash = hashIndex >= 0 ? remainder.slice(0, hashIndex) : remainder;
    const fragment = hashIndex >= 0 ? remainder.slice(hashIndex + 1).trim() : '';
    const queryIndex = withoutHash.indexOf('?');
    const rawLocation = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

    // Reject 4-slash UNC network paths (file:////server/share/file) and empty locations.
    if (!rawLocation || rawLocation.startsWith('//')) {
        return null;
    }

    let authorityless: string;
    if (rawLocation.startsWith('/')) {
        authorityless = rawLocation;
    } else if (/^localhost\//i.test(rawLocation)) {
        const afterHost = rawLocation.slice('localhost'.length);
        if (afterHost.startsWith('//')) {
            return null;
        }
        authorityless = afterHost;
    } else if (/^~[\\/]/.test(rawLocation)) {
        authorityless = rawLocation;
    } else {
        // Check after percent-decoding only for Windows drive authorities (file://c%3A/... or file://C:/...),
        // rejecting non-local host authorities such as file://remote-host/share/file.
        let decodedCandidate = rawLocation;
        try {
            decodedCandidate = decodeURIComponent(rawLocation);
        } catch {
            decodedCandidate = rawLocation;
        }
        if (!WINDOWS_ABSOLUTE_PATH.test(decodedCandidate)) {
            return null;
        }
        authorityless = decodedCandidate;
    }

    let decodedPath = authorityless;
    try {
        decodedPath = decodeURIComponent(authorityless);
    } catch {
        decodedPath = authorityless;
    }

    // Strip leading slash before Windows drive letters (including decoded file:///c%3A/Users/...)
    // and before home-relative paths (file:///~/...).
    if (/^\/[A-Za-z]:[\\/]/.test(decodedPath) || /^\/~[\\/]/.test(decodedPath)) {
        decodedPath = decodedPath.slice(1);
    }

    if (!decodedPath || /[\0\r\n]/.test(decodedPath)) {
        return null;
    }

    let fragmentLine: number | null = null;
    let fragmentColumn: number | null = null;
    if (fragment) {
        const match = fragment.match(LINE_FRAGMENT);
        if (match) {
            fragmentLine = Number.parseInt(match[1], 10);
            fragmentColumn = match[2] ? Number.parseInt(match[2], 10) : null;
        }
    }

    const parsedPath = fragmentLine !== null
        ? { path: decodedPath.trim(), line: null, column: null }
        : parseLineAndColumn(decodedPath);
    return {
        path: parsedPath.path,
        line: fragmentLine ?? parsedPath.line,
        column: fragmentColumn ?? parsedPath.column,
    };
}

function decodeFileUrl(value: string): string {
    if (!FILE_URL_PREFIX.test(value)) {
        return value;
    }
    return parseFileUrlTarget(value)?.path ?? '';
}

const ENCODED_PATH_PREFIX = 'b64u:';

export function encodeSessionFilePathParam(path: string): string {
    return `${ENCODED_PATH_PREFIX}${encodeBase64(new TextEncoder().encode(path), 'base64url')}`;
}

export function decodeSessionFilePathParam(encodedPath: string): string {
    if (!encodedPath) {
        return '';
    }
    let normalized = encodedPath;
    try {
        normalized = decodeURIComponent(encodedPath);
    } catch {
        normalized = encodedPath;
    }
    if (normalized.startsWith(ENCODED_PATH_PREFIX)) {
        const payload = normalized.slice(ENCODED_PATH_PREFIX.length);
        try {
            const bytes = decodeBase64(payload, 'base64url');
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            return normalized;
        }
    }
    // Preserve raw unencoded paths directly.
    if (normalized.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalized) || RELATIVE_PREFIX.test(normalized)) {
        return normalized;
    }
    // Legacy ASCII btoa() callers produce padded standard base64 of length % 4 === 0.
    // Validate strict UTF-8, absence of control chars, and a path separator so plain
    // filenames like "Makefile" or "src/main" are never misdecoded into binary garbage.
    if (normalized.length >= 4 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        try {
            const bytes = decodeBase64(normalized, 'base64');
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (decoded && !/[\x00-\x1f\x7f]/.test(decoded) && HAS_PATH_SEPARATOR.test(decoded)) {
                return decoded;
            }
        } catch {
            return normalized;
        }
    }
    return normalized;
}

export function buildSessionFileRoute(
    sessionId: string,
    target: string | Pick<SessionFileLink, 'absolutePath' | 'line' | 'column'>,
): string {
    const absolutePath = typeof target === 'string' ? target : target.absolutePath;
    const line = typeof target === 'string' ? null : target.line;
    const column = typeof target === 'string' ? null : target.column;
    const params = [`path=${encodeURIComponent(encodeSessionFilePathParam(absolutePath))}`];
    if (line !== null && Number.isFinite(line) && line > 0) {
        params.push(`line=${line}`);
    }
    if (column !== null && Number.isFinite(column) && column > 0) {
        params.push(`column=${column}`);
    }
    return `/session/${encodeURIComponent(sessionId)}/file?${params.join('&')}`;
}

function inferHomeDirectory(sessionRoot: string | null | undefined): string | null {
    if (!sessionRoot) {
        return null;
    }
    const normalizedRoot = normalizePath(sessionRoot);
    const match = normalizedRoot.match(/^([A-Za-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+)/);
    return match?.[1] ?? null;
}

function expandHomePath(value: string, sessionRoot: string | null | undefined): string {
    if (!value.startsWith('~/')) {
        return value;
    }
    const home = inferHomeDirectory(sessionRoot);
    if (!home) {
        return value;
    }
    return `${home}/${value.slice(2)}`;
}

function normalizePath(value: string): string {
    const withForwardSlashes = value.replace(/\\/g, '/');
    const isWindowsAbsolute = /^[A-Za-z]:\//.test(withForwardSlashes);
    const isPosixAbsolute = withForwardSlashes.startsWith('/');
    const prefix = isWindowsAbsolute ? `${withForwardSlashes[0].toUpperCase()}:/` : isPosixAbsolute ? '/' : '';
    const rawRemainder = isWindowsAbsolute ? withForwardSlashes.slice(3) : isPosixAbsolute ? withForwardSlashes.replace(/^\/+/, '') : withForwardSlashes;

    const parts = rawRemainder.split('/');
    const normalizedParts: string[] = [];

    for (const part of parts) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (normalizedParts.length > 0 && normalizedParts[normalizedParts.length - 1] !== '..') {
                normalizedParts.pop();
            } else if (!prefix) {
                normalizedParts.push(part);
            }
            continue;
        }
        normalizedParts.push(part);
    }

    if (!prefix) {
        return normalizedParts.join('/');
    }
    if (normalizedParts.length === 0) {
        return prefix;
    }
    return `${prefix}${normalizedParts.join('/')}`;
}

function resolvePath(path: string, sessionRoot: string | null | undefined): string | null {
    const expandedPath = expandHomePath(decodeFileUrl(path), sessionRoot);
    if (!expandedPath) {
        return null;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(expandedPath) || POSIX_ABSOLUTE_PATH.test(expandedPath)) {
        return normalizePath(expandedPath);
    }
    if (!sessionRoot) {
        return null;
    }
    return normalizePath(`${normalizePath(sessionRoot)}/${expandedPath}`);
}

function isWithinRoot(path: string, root: string | null | undefined): boolean {
    if (!root) {
        return false;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function getRelativePath(path: string, root: string | null | undefined): string | null {
    if (!isWithinRoot(path, root) || !root) {
        return null;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    if (normalizedPath === normalizedRoot) {
        return '.';
    }
    return normalizedPath.slice(normalizedRoot.length + 1);
}

function looksLikeBareFileName(value: string): boolean {
    if (!BARE_FILE_NAME.test(value)) {
        return false;
    }
    const extension = value.split('.').pop() ?? '';
    return !NUMERIC_EXTENSION.test(extension);
}

function hasFileLikeEnding(value: string): boolean {
    const normalized = normalizePath(value);
    const basename = normalized.split('/').pop() ?? normalized;
    if (!basename) {
        return false;
    }
    if (EXTENSIONLESS_FILE_NAMES.has(basename)) {
        return true;
    }
    if (basename.startsWith('.')) {
        return basename.length > 1;
    }
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex === basename.length - 1) {
        return false;
    }
    const extension = basename.slice(lastDotIndex + 1);
    if (!FILE_EXTENSION.test(extension)) {
        return false;
    }
    return !NUMERIC_EXTENSION.test(extension);
}

function isAppRoute(value: string): boolean {
    return APP_ROUTE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function looksLikePath(value: string, options?: { explicitFileUrl?: boolean }): boolean {
    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
        return true;
    }
    if (POSIX_ABSOLUTE_PATH.test(trimmed)) {
        return options?.explicitFileUrl ? trimmed.length > 1 : !isAppRoute(trimmed);
    }
    if (RELATIVE_PREFIX.test(trimmed)) {
        return true;
    }
    if (HAS_PATH_SEPARATOR.test(trimmed)) {
        return true;
    }
    return looksLikeBareFileName(trimmed);
}

function buildLink(path: string, line: number | null, column: number | null, sessionRoot: string | null | undefined): SessionFileLink | null {
    const absolutePath = resolvePath(path, sessionRoot);
    if (!absolutePath) {
        return null;
    }
    return {
        path: normalizePath(path),
        absolutePath,
        relativePath: getRelativePath(absolutePath, sessionRoot),
        withinSessionRoot: isWithinRoot(absolutePath, sessionRoot),
        line,
        column,
    };
}

export function resolveSessionFilePath(
    path: string,
    sessionRoot?: string | null,
    options?: { literalPath?: boolean },
): SessionFileLink | null {
    if (FILE_URL_PREFIX.test(path.trim())) {
        const parsedFileUrl = parseFileUrlTarget(path);
        if (!parsedFileUrl) {
            return null;
        }
        return buildLink(parsedFileUrl.path, parsedFileUrl.line, parsedFileUrl.column, sessionRoot);
    }
    if (options?.literalPath) {
        return buildLink(path.trim(), null, null, sessionRoot);
    }
    const parsed = parseLineAndColumn(path);
    return buildLink(parsed.path, parsed.line, parsed.column, sessionRoot);
}

export function parseSessionFileLink(
    url: string,
    options?: { label?: string | null; sessionRoot?: string | null; bareText?: boolean }
): SessionFileLink | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    if (FILE_URL_PREFIX.test(trimmedUrl)) {
        const parsedFileUrl = parseFileUrlTarget(trimmedUrl);
        if (!parsedFileUrl || !looksLikePath(parsedFileUrl.path, { explicitFileUrl: true })) {
            return null;
        }
        const parsedLabel = options?.label ? parseLineAndColumn(options.label) : null;
        const effectiveRoot = options?.sessionRoot ?? (parsedFileUrl.path.startsWith('~/') ? '/home/user' : undefined);
        const built = buildLink(
            parsedFileUrl.path,
            parsedFileUrl.line ?? parsedLabel?.line ?? null,
            parsedFileUrl.column ?? parsedLabel?.column ?? null,
            options?.sessionRoot,
        );
        if (built) {
            return built;
        }
        // When rendering spans without sessionRoot, keep ~/... file:// links recognizable
        // while preserving the unexpanded ~/... path for resolution at navigation time.
        if (!options?.sessionRoot && parsedFileUrl.path.startsWith('~/') && effectiveRoot) {
            return {
                path: normalizePath(parsedFileUrl.path),
                absolutePath: normalizePath(parsedFileUrl.path),
                relativePath: null,
                withinSessionRoot: false,
                line: parsedFileUrl.line ?? parsedLabel?.line ?? null,
                column: parsedFileUrl.column ?? parsedLabel?.column ?? null,
            };
        }
        return null;
    }

    if (!WINDOWS_ABSOLUTE_PATH.test(trimmedUrl) && URL_SCHEME.test(trimmedUrl)) {
        return null;
    }

    const parsedUrl = parseLineAndColumn(trimmedUrl);
    const parsedLabel = options?.label ? parseLineAndColumn(options.label) : null;

    if (!looksLikePath(parsedUrl.path) && !looksLikePath(parsedLabel?.path ?? '')) {
        return null;
    }

    if (options?.bareText) {
        const hasStrongSignal =
            parsedUrl.line !== null ||
            parsedUrl.column !== null ||
            hasFileLikeEnding(parsedUrl.path);
        if (!hasStrongSignal) {
            return null;
        }
    }

    return buildLink(
        parsedUrl.path,
        parsedUrl.line ?? parsedLabel?.line ?? null,
        parsedUrl.column ?? parsedLabel?.column ?? null,
        options?.sessionRoot,
    );
}

type TokenMatch = {
    start: number;
    end: number;
};

function looksLikePathStart(text: string): boolean {
    if (!text) {
        return false;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(text)) {
        return true;
    }
    if (text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../')) {
        return true;
    }
    return HAS_PATH_SEPARATOR.test(text);
}

export function splitSessionFileText(text: string, sessionRoot?: string | null): SessionFileTextSegment[] {
    const segments: SessionFileTextSegment[] = [];
    const tokenPattern = /\S+/g;
    const tokens: TokenMatch[] = [];
    let match: RegExpExecArray | null;

    while ((match = tokenPattern.exec(text)) !== null) {
        tokens.push({ start: match.index, end: match.index + match[0].length });
    }

    let cursor = 0;
    let tokenIndex = 0;

    while (tokenIndex < tokens.length) {
        const token = tokens[tokenIndex];
        const tokenText = text.slice(token.start, token.end);
        const strippedStart = stripToken(tokenText).core;

        if (!looksLikePathStart(strippedStart)) {
            tokenIndex += 1;
            continue;
        }

        let bestEnd = -1;
        let bestLink: SessionFileLink | null = null;
        let bestLeading = '';
        let bestCore = '';
        let bestTrailing = '';

        for (let candidateIndex = tokenIndex; candidateIndex < tokens.length; candidateIndex += 1) {
            const candidate = text.slice(token.start, tokens[candidateIndex].end);
            const stripped = stripToken(candidate);
            if (!stripped.core) {
                continue;
            }

            const link = parseSessionFileLink(stripped.core, {
                sessionRoot,
                bareText: true,
            });

            if (link) {
                bestEnd = candidateIndex;
                bestLink = link;
                bestLeading = stripped.leading;
                bestCore = stripped.core;
                bestTrailing = stripped.trailing;
            }
        }

        if (bestEnd === -1 || !bestLink) {
            tokenIndex += 1;
            continue;
        }

        const end = tokens[bestEnd].end;
        pushTextSegment(segments, text.slice(cursor, token.start));
        pushTextSegment(segments, bestLeading);
        segments.push({ text: bestCore, link: bestLink });
        pushTextSegment(segments, bestTrailing);
        cursor = end;
        tokenIndex = bestEnd + 1;
    }

    if (cursor < text.length) {
        pushTextSegment(segments, text.slice(cursor));
    }

    return segments;
}
