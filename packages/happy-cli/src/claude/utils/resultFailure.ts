import type { SDKResultMessage } from '@/claude/sdk';

export const MAX_RESULT_FAILURE_DETAIL = 500;

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

function sanitizeErrorDetails(errors: readonly unknown[]): string | null {
    const detail = errors
        .map(sanitizeDetail)
        .filter((error): error is string => Boolean(error))
        .filter((error, index, all) => all.indexOf(error) === index)
        .join('; ');

    if (!detail) {
        return null;
    }
    return detail.length > MAX_RESULT_FAILURE_DETAIL
        ? `${detail.slice(0, MAX_RESULT_FAILURE_DETAIL)}…`
        : detail;
}

/**
 * Turn an official Claude Agent SDK error result into a user-visible message.
 * Result messages are not written to the transcript, so this is the only path
 * by which the app can learn about these failures.
 */
export function describeClaudeResultFailure(result: SDKResultMessage): string | null {
    const message = result as SDKResultMessage & {
        is_error?: boolean;
        api_error_status?: number | null;
        result?: unknown;
        errors?: readonly unknown[];
        num_turns?: number;
    };
    const rawSubtype = (result as unknown as { subtype?: unknown }).subtype;
    const subtype = typeof rawSubtype === 'string' && rawSubtype.length > 0
        ? rawSubtype
        : 'unknown';

    if (subtype === 'success') {
        if (!message.is_error) {
            return null;
        }

        const status = typeof message.api_error_status === 'number'
            ? ` (API ${message.api_error_status})`
            : '';
        const detail = sanitizeDetail(message.result);
        const summary = `Claude reported an error${status}`;
        return detail ? `${summary}: ${detail}` : summary;
    }

    const detail = sanitizeErrorDetails(Array.isArray(message.errors) ? message.errors : []);
    let summary: string;

    switch (subtype) {
        case 'error_during_execution':
            summary = 'Claude stopped: error during execution';
            break;
        case 'error_max_turns':
            summary = typeof message.num_turns === 'number'
                ? `Claude stopped: reached the maximum number of turns (${message.num_turns}) without completing`
                : 'Claude stopped: reached the maximum number of turns without completing';
            break;
        case 'error_max_budget_usd':
            summary = 'Claude stopped: reached the maximum budget';
            break;
        case 'error_max_structured_output_retries':
            summary = 'Claude stopped: could not produce valid structured output after the maximum retries';
            break;
        default:
            // Keep future SDK error subtypes visible even before the local
            // TypeScript dependency learns about them.
            summary = `Claude stopped with an error (${subtype})`;
            break;
    }

    return detail ? `${summary} — ${detail}` : summary;
}
