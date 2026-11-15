import { describe, expect, it } from 'vitest';
import { resolveDeepSeekOptions } from './options';

describe('DeepSeek harness configuration', () => {
    it('uses DeepSeek credentials and models even when Claude is configured in the shell', () => {
        const ambient = {
            DEEPSEEK_API_KEY: ' deepseek-key ',
            ANTHROPIC_BASE_URL: 'https://another-provider.example',
            ANTHROPIC_API_KEY: 'claude-key',
            CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
        };
        const options = resolveDeepSeekOptions({ claudeEnvVars: { CUSTOM_FLAG: 'kept' } }, ambient);
        expect(options).toMatchObject({
            flavor: 'deepseek', model: 'deepseek-flash', effort: 'high',
            claudeEnvVars: {
                ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
                ANTHROPIC_AUTH_TOKEN: 'deepseek-key',
                ANTHROPIC_API_KEY: '',
                CLAUDE_CODE_OAUTH_TOKEN: '',
                ANTHROPIC_MODEL: 'deepseek-flash',
                ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash',
                ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
                ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
                CUSTOM_FLAG: 'kept',
            },
        });
        expect(ambient.ANTHROPIC_API_KEY).toBe('claude-key');
        expect(ambient.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-oauth');
    });

    it('preserves an explicit model, effort, and launch mode', () => {
        const options = resolveDeepSeekOptions({
            model: 'deepseek-v4-pro', effort: 'max', startingMode: 'remote',
            claudeEnvVars: { DEEPSEEK_API_KEY: 'session-key' },
        }, { DEEPSEEK_API_KEY: 'daemon-key' });
        expect(options).toMatchObject({
            model: 'deepseek-v4-pro', effort: 'max', startingMode: 'remote',
            claudeEnvVars: { ANTHROPIC_MODEL: 'deepseek-v4-pro', ANTHROPIC_AUTH_TOKEN: 'session-key' },
        });
    });

    it.each([undefined, '', '  '])('fails before launch when the DeepSeek key is %s', (key) => {
        expect(() => resolveDeepSeekOptions({}, { DEEPSEEK_API_KEY: key, ANTHROPIC_API_KEY: 'unrelated' }))
            .toThrow('DEEPSEEK_API_KEY');
    });

    it.each(['claude-opus-5', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'])('rejects a retired or foreign model: %s', (model) => {
        expect(() => resolveDeepSeekOptions({ model }, { DEEPSEEK_API_KEY: 'key' }))
            .toThrow('Unsupported DeepSeek model');
    });

    it('rejects a non-native effort instead of silently changing its meaning', () => {
        expect(() => resolveDeepSeekOptions({ effort: 'medium' }, { DEEPSEEK_API_KEY: 'key' }))
            .toThrow('Unsupported DeepSeek effort');
    });
});
