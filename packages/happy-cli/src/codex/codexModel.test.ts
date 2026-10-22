import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_MODEL, resolveCodexModel } from './codexModel';

describe('resolveCodexModel', () => {
    it.each([undefined, '', '   ', 'default', ' default '])('uses GPT-6.1 Sol for an unset/default selection: %s', model => {
        expect(resolveCodexModel(model)).toBe('gpt-6.1-sol');
        expect(resolveCodexModel(model)).toBe(DEFAULT_CODEX_MODEL);
    });

    it('preserves the explicit model selection', () => {
        expect(resolveCodexModel('gpt-6-astra')).toBe('gpt-6-astra');
        expect(resolveCodexModel(' gpt-5.6-sol ')).toBe('gpt-5.6-sol');
    });
});
