// Current public API models, verified 2026-11-15:
// https://api-docs.deepseek.com/quick_start/pricing
// UI mark: https://api-docs.deepseek.com/img/logo-mark-light.svg
// Retired aliases (including deepseek-chat/reasoner) are not picker entries.
export const DEEPSEEK_MODELS = [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_000_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
] as const;

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
// https://api-docs.deepseek.com/guides/thinking_mode
export const DEEPSEEK_EFFORT_LEVELS = ['low', 'high', 'max'] as const;
