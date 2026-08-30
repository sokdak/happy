import { describe, expect, it } from 'vitest';
import { resolveCodexModel } from './codexModel';

describe('resolveCodexModel', () => {
    it('uses the model the user asked for', () => {
        expect(resolveCodexModel('gpt-5.4', {})).toBe('gpt-5.4');
    });

    it('lets an explicit model win over the deployment override', () => {
        expect(resolveCodexModel('gpt-5.4', { HAPPY_CODEX_MODEL: 'gpt-5.6-sol' })).toBe('gpt-5.4');
    });

    it('falls back to the deployment override', () => {
        expect(resolveCodexModel(undefined, { HAPPY_CODEX_MODEL: 'gpt-5.6-sol' })).toBe('gpt-5.6-sol');
    });

    it('picks nothing when neither is set', () => {
        // Not a hardcoded model: Codex then reads its own config, which is the
        // only place that knows what this deployment is allowed to run.
        expect(resolveCodexModel(undefined, {})).toBeUndefined();
    });

    it('treats the default sentinel as "no model"', () => {
        expect(resolveCodexModel('default', {})).toBeUndefined();
        expect(resolveCodexModel(undefined, { HAPPY_CODEX_MODEL: 'default' })).toBeUndefined();
    });

    it('still consults the override when the request says default', () => {
        expect(resolveCodexModel('default', { HAPPY_CODEX_MODEL: 'gpt-5.6-sol' })).toBe('gpt-5.6-sol');
    });

    it('ignores an override that is only whitespace', () => {
        expect(resolveCodexModel(undefined, { HAPPY_CODEX_MODEL: '   ' })).toBeUndefined();
    });

    it('trims the override', () => {
        expect(resolveCodexModel(undefined, { HAPPY_CODEX_MODEL: ' gpt-5.6-sol ' })).toBe('gpt-5.6-sol');
    });
});
