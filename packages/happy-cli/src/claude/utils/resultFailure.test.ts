import { describe, expect, it } from 'vitest';
import type { SDKResultMessage } from '@/claude/sdk';
import { describeClaudeResultFailure, MAX_RESULT_FAILURE_DETAIL } from './resultFailure';

type ErrorSubtype = Exclude<SDKResultMessage['subtype'], 'success'>;

function resultMessage(
    subtype: SDKResultMessage['subtype'],
    overrides: Record<string, unknown> = {},
): SDKResultMessage {
    return {
        type: 'result',
        subtype,
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: subtype !== 'success',
        num_turns: 10,
        stop_reason: null,
        total_cost_usd: 0.05,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'result-1',
        session_id: 'session-1',
        ...(subtype === 'success' ? { result: 'All done' } : { errors: [] }),
        ...overrides,
    } as unknown as SDKResultMessage;
}

describe('describeClaudeResultFailure', () => {
    it('returns null for a successful result', () => {
        expect(describeClaudeResultFailure(resultMessage('success'))).toBeNull();
    });

    it('reports legacy success results flagged as errors', () => {
        const failure = describeClaudeResultFailure(resultMessage('success', {
            is_error: true,
            api_error_status: 429,
            result: 'API Error:\nrate limited',
        }));

        expect(failure).toBe('Claude reported an error (API 429): API Error: rate limited');
    });

    it.each<[ErrorSubtype, RegExp]>([
        ['error_during_execution', /error during execution/i],
        ['error_max_turns', /maximum number of turns \(10\)/i],
        ['error_max_budget_usd', /maximum budget/i],
        ['error_max_structured_output_retries', /valid structured output/i],
    ])('reports the official %s subtype', (subtype, expected) => {
        expect(describeClaudeResultFailure(resultMessage(subtype))).toMatch(expected);
    });

    it('shows sanitized SDK errors without repeating duplicate detail', () => {
        const failure = describeClaudeResultFailure(resultMessage('error_during_execution', {
            errors: [
                '\u001b[31mfatal:\u001b[0m  process\nfailed\tbadly',
                'fatal: process failed badly',
            ],
        }));

        expect(failure).toContain('fatal: process failed badly');
        expect(failure?.match(/fatal:/g)).toHaveLength(1);
        expect(failure).not.toContain('\u001b');
        expect(failure).not.toContain('\n');
    });

    it('truncates very long SDK error detail', () => {
        const failure = describeClaudeResultFailure(resultMessage('error_max_budget_usd', {
            errors: ['x'.repeat(MAX_RESULT_FAILURE_DETAIL * 2)],
        }));

        expect(failure).toBeTruthy();
        expect(failure!.length).toBeLessThan(MAX_RESULT_FAILURE_DETAIL + 100);
        expect(failure).toMatch(/…$/);
    });

    it('also bounds legacy success-error detail', () => {
        const failure = describeClaudeResultFailure(resultMessage('success', {
            is_error: true,
            result: 'x'.repeat(MAX_RESULT_FAILURE_DETAIL * 2),
        }));

        expect(failure!.length).toBeLessThan(MAX_RESULT_FAILURE_DETAIL + 100);
        expect(failure).toMatch(/…$/);
    });

    it('keeps future SDK error subtypes visible without assuming errors exists', () => {
        const failure = describeClaudeResultFailure(resultMessage('error_during_execution', {
            subtype: 'error_future_limit',
            errors: undefined,
        }));

        expect(failure).toBe('Claude stopped with an error (error_future_limit)');
    });
});
