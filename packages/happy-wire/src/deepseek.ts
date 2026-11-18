// Current public API models, verified 2026-11-15:
// https://api-docs.deepseek.com/quick_start/pricing
// UI mark: https://api-docs.deepseek.com/img/logo-mark-light.svg
// Retired aliases (including deepseek-chat/reasoner) are not picker entries.
export const DEEPSEEK_MODELS = [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_048_576 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576 },
] as const;

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
// https://api-docs.deepseek.com/guides/thinking_mode
export const DEEPSEEK_EFFORT_LEVELS = ['off', 'low', 'high', 'max'] as const;
