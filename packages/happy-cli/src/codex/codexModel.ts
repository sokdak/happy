export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';

/** Preserve explicit picks and resolve the app's default row to Happy's default. */
export function resolveCodexModel(requested: string | undefined): string {
    const model = requested?.trim();
    return model && model !== 'default' ? model : DEFAULT_CODEX_MODEL;
}
