/**
 * Builds the `git diff` invocations the diff views run over the session shell.
 *
 * A patch only carries the lines git chose to include, so anything the viewer
 * wants beyond that — more surrounding context, whitespace-only changes folded
 * away — has to be asked of git again with different flags. Keeping the command
 * in one place means both callers ask the same way and it can be tested without
 * a shell.
 */

export interface GitDiffOptions {
    /** Lines of context around each change. Omit for git's default of 3. */
    contextLines?: number;
    /** Fold away changes that are only whitespace. */
    ignoreWhitespace?: boolean;
}

/** Context wide enough to swallow any real file, used for "show everything". */
export const FULL_FILE_CONTEXT = 100_000;

/**
 * Quotes a path for a double-quoted shell argument. Paths come from git itself
 * rather than from the user, but a filename may legitimately contain a quote or
 * a backslash, and an unescaped one would break the command apart.
 */
export function quoteShellPath(path: string): string {
    if (/[\0\r\n]/.test(path)) {
        throw new Error('Invalid control character in git path');
    }
    return `"${path.replace(/([\\"$`])/g, '\\$1')}"`;
}

/**
 * Builds a shell-safe working-tree `git diff` command for `FileScreen` and
 * prefetchers. Returns `null` when the path is empty, `.`, or contains control
 * characters (or Windows `cmd.exe` metacharacters when the session root is a
 * Windows drive path) so untrusted `file://` links can never inject shell code.
 */
export function buildWorkingTreeGitDiffCommand(
    path: string | null | undefined,
    sessionRoot?: string | null,
): string | null {
    if (!path || path === '.' || /[\0\r\n]/.test(path)) {
        return null;
    }
    const isWindowsSession = Boolean(sessionRoot && /^[A-Za-z]:[\\/]/.test(sessionRoot));
    if (isWindowsSession) {
        if (/[%"&|<>^!`$]/.test(path)) {
            return null;
        }
        return `git -c core.quotepath=false diff --no-ext-diff -- "${path.replace(/\\/g, '/')}"`;
    }
    const posixSingleQuoted = `'${path.replace(/'/g, `'\\''`)}'`;
    return `git -c core.quotepath=false diff --no-ext-diff -- ${posixSingleQuoted}`;
}

export function buildGitDiffCommand(path: string, options: GitDiffOptions = {}): string {
    const flags = ['--no-ext-diff'];
    if (options.contextLines !== undefined) {
        flags.push(`-U${options.contextLines}`);
    }
    if (options.ignoreWhitespace) {
        flags.push('-w');
    }
    return `git -c core.quotepath=false diff HEAD ${flags.join(' ')} -- ${quoteShellPath(path)}`;
}

/** Reads a tracked file as it stands in HEAD, base64 so binary survives. */
export function buildGitShowBase64Command(path: string): string {
    return `git -c core.quotepath=false show HEAD:${quoteShellPath(path)} | base64`;
}
