/**
 * Tests for describeClaudeResultFailure — turning SDK error results into
 * user-visible failure messages instead of silently dropping them.
 */

import { describe, it, expect } from 'vitest'
import { describeClaudeResultFailure, MAX_RESULT_FAILURE_DETAIL } from './resultFailure'
import type { SDKResultMessage } from '@/claude/sdk'

function resultMessage(overrides: Record<string, unknown>): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        total_cost_usd: 0.05,
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        session_id: 'session-1',
        ...overrides,
    } as unknown as SDKResultMessage
}

describe('describeClaudeResultFailure', () => {
    it('returns null for a clean success result', () => {
        expect(describeClaudeResultFailure(resultMessage({ result: 'All done' }))).toBeNull()
    })

    it('reports success results flagged as errors, including the error text', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            is_error: true,
            result: 'API Error: 429 rate limit exceeded',
        }))
        expect(failure).toContain('API Error: 429 rate limit exceeded')
    })

    it('reports error_max_turns with the turn count', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            subtype: 'error_max_turns',
            is_error: true,
            num_turns: 10,
        }))
        expect(failure).toMatch(/maximum.*turns/i)
        expect(failure).toContain('10')
    })

    it('reports error_during_execution', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            subtype: 'error_during_execution',
            is_error: true,
        }))
        expect(failure).toMatch(/error during execution/i)
    })

    it('includes error detail on error_during_execution when the SDK provides one', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            subtype: 'error_during_execution',
            is_error: true,
            result: 'Process exited with code 1',
        }))
        expect(failure).toContain('Process exited with code 1')
    })

    it('reports unknown error subtypes generically instead of dropping them', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            subtype: 'error_budget_exceeded',
            is_error: true,
        }))
        expect(failure).toBeTruthy()
        expect(failure).toContain('error_budget_exceeded')
    })

    it('collapses whitespace and strips ANSI escapes from the detail', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            is_error: true,
            result: '\u001b[31mfatal:\u001b[0m  something\nbroke\tbadly',
        }))
        expect(failure).toContain('fatal: something broke badly')
        expect(failure).not.toContain('\u001b')
        expect(failure).not.toContain('\n')
    })

    it('truncates very long detail', () => {
        const failure = describeClaudeResultFailure(resultMessage({
            is_error: true,
            result: 'x'.repeat(MAX_RESULT_FAILURE_DETAIL * 2),
        }))
        expect(failure).toBeTruthy()
        expect(failure!.length).toBeLessThan(MAX_RESULT_FAILURE_DETAIL + 100)
    })
})
