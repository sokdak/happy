import {
    DEEPSEEK_ANTHROPIC_BASE_URL,
    DEEPSEEK_DEFAULT_MODEL,
    DEEPSEEK_EFFORT_LEVELS,
    DEEPSEEK_MODELS,
} from '@slopus/happy-wire';
import type { StartOptions } from '@/claude/runClaude';

/** Configure the existing Claude Code harness without changing the daemon's credentials. */
export function resolveDeepSeekOptions(options: StartOptions, env: NodeJS.ProcessEnv = process.env): StartOptions {
    const apiKey = (options.claudeEnvVars?.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY)?.trim();
    if (!apiKey) {
        throw new Error('DeepSeek requires DEEPSEEK_API_KEY on the machine running Happy. Set it before starting the daemon or running happy deepseek.');
    }
    const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    if (!DEEPSEEK_MODELS.some((candidate) => candidate.id === model)) {
        throw new Error(`Unsupported DeepSeek model: ${model}. Choose ${DEEPSEEK_MODELS.map((candidate) => candidate.id).join(', ')}.`);
    }
    const effort = options.effort ?? 'high';
    if (!(DEEPSEEK_EFFORT_LEVELS as readonly string[]).includes(effort)) {
        throw new Error(`Unsupported DeepSeek effort: ${effort}. Choose ${DEEPSEEK_EFFORT_LEVELS.join(', ')}.`);
    }
    return {
        ...options,
        flavor: 'deepseek',
        model,
        effort,
        claudeEnvVars: {
            ...options.claudeEnvVars,
            ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: apiKey,
            ANTHROPIC_API_KEY: apiKey,
            CLAUDE_CODE_OAUTH_TOKEN: '',
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
            ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_DEFAULT_MODEL,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_DEFAULT_MODEL,
            ANTHROPIC_SMALL_FAST_MODEL: DEEPSEEK_DEFAULT_MODEL,
            CLAUDE_CODE_EFFORT_LEVEL: effort,
            CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_DEFAULT_MODEL,
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            API_TIMEOUT_MS: '600000',
        },
    };
}
