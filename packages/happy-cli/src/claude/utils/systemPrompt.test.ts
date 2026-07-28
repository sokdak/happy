import { describe, expect, it, vi } from 'vitest';

vi.mock('./claudeSettings', () => ({
    shouldIncludeCoAuthoredBy: () => true,
}));

import { systemPrompt } from './systemPrompt';

describe('systemPrompt commit attribution', () => {
    it('keeps Claude attribution without adding Happy attribution', () => {
        expect(systemPrompt).toContain('Generated with [Claude Code](https://claude.ai/code)');
        expect(systemPrompt).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
        expect(systemPrompt).not.toContain('via [Happy]');
        expect(systemPrompt).not.toContain('Co-Authored-By: Happy');
    });
});
