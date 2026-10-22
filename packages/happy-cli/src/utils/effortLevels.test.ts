import { describe, expect, it } from 'vitest';
import { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS, agentSupportsEffortLevel } from './effortLevels';

describe('effort vocabularies', () => {
    // These two lists are not the same, which is the whole reason this module
    // exists: `none`/`minimal`/`ultra` are Codex-only, so an effort level
    // cannot be moved between agents unconditionally.
    it('gives Codex levels at both ends that Claude does not have', () => {
        for (const level of ['none', 'minimal', 'ultra']) {
            expect(CODEX_EFFORT_LEVELS).toContain(level);
            expect(CLAUDE_EFFORT_LEVELS).not.toContain(level);
        }
    });

    it('shares everything from low to max', () => {
        for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
            expect(CLAUDE_EFFORT_LEVELS).toContain(level);
            expect(CODEX_EFFORT_LEVELS).toContain(level);
        }
    });
});

describe('agentSupportsEffortLevel', () => {
    it('accepts a level the agent knows', () => {
        expect(agentSupportsEffortLevel('codex', 'medium')).toBe(true);
        expect(agentSupportsEffortLevel('claude', 'max')).toBe(true);
        expect(agentSupportsEffortLevel('codex', 'minimal')).toBe(true);
    });

    it('rejects a level that belongs to the other agent', () => {
        expect(agentSupportsEffortLevel('claude', 'minimal')).toBe(false);
        expect(agentSupportsEffortLevel('claude', 'none')).toBe(false);
        expect(agentSupportsEffortLevel('claude', 'ultra')).toBe(false);
    });

    it('rejects agents that take no effort level at all', () => {
        // The daemon only ever passes --effort to claude and codex.
        expect(agentSupportsEffortLevel('gemini', 'medium')).toBe(false);
        expect(agentSupportsEffortLevel('agy', 'medium')).toBe(false);
        expect(agentSupportsEffortLevel('openclaw', 'medium')).toBe(false);
    });

    it('rejects a level nobody defines', () => {
        expect(agentSupportsEffortLevel('codex', 'turbo')).toBe(false);
    });
});
