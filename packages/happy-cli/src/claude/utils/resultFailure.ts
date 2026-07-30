/**
 * The SDK's `result` message is the only place Claude reports that a turn
 * finished with an error (`error_max_turns`, `error_during_execution`, or a
 * `success` result flagged `is_error`). Result messages are deliberately not
 * part of the transcript log, so unless the failure is surfaced explicitly the
 * app shows nothing at all — the session just goes idle. This helper turns an
 * error result into a single-line, user-visible failure message; it returns
 * null for clean successes.
 */

import type { SDKResultMessage } from '@/claude/sdk'

export const MAX_RESULT_FAILURE_DETAIL = 500;

/** Strip ANSI escapes and control characters, collapse to a single line. */
function sanitizeDetail(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const detail = raw
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!detail) {
        return null;
    }
    return detail.length > MAX_RESULT_FAILURE_DETAIL
        ? `${detail.slice(0, MAX_RESULT_FAILURE_DETAIL)}…`
        : detail;
}

export function describeClaudeResultFailure(result: SDKResultMessage): string | null {
    const msg = result as SDKResultMessage & {
        result?: unknown;
        error?: unknown;
        num_turns?: number;
    };

    // Newer SDK versions may attach the error text under different fields;
    // check them all so a provided reason is never dropped.
    const errorField = msg.error;
    const detail = sanitizeDetail(msg.result)
        ?? sanitizeDetail(errorField)
        ?? sanitizeDetail((errorField as { message?: unknown } | undefined)?.message);

    switch (msg.subtype) {
        case 'success':
            if (!msg.is_error) {
                return null;
            }
            return detail
                ? `Claude reported an error: ${detail}`
                : 'Claude reported an error without details';
        case 'error_max_turns':
            return `Claude stopped: reached the maximum number of turns (${msg.num_turns}) without completing`;
        case 'error_during_execution':
            return detail
                ? `Claude stopped: error during execution — ${detail}`
                : 'Claude stopped: error during execution';
        default:
            // Unknown subtype — future SDK versions may add new error kinds.
            // Anything that is not a clean success must still reach the user.
            return detail
                ? `Claude stopped (${msg.subtype}): ${detail}`
                : `Claude stopped with an error (${msg.subtype})`;
    }
}
