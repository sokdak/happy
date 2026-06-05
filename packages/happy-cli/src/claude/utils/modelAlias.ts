/**
 * Map Happy's Claude model-mode aliases to explicit model ids before handing them to the
 * agent SDK.
 *
 * Why: the bundled `@anthropic-ai/claude-agent-sdk` runtime resolves the bare `opus` alias
 * to an older Opus (`claude-opus-4-7`), so the app's "opus 4.8" option silently produced
 * 4.7 sessions. Passing the explicit id pins the model the UI advertises, independent of the
 * SDK's (possibly stale) alias table. `sonnet`/`haiku` currently resolve correctly but are
 * pinned for the same reason — the picker label is the source of truth.
 *
 * This is the ONLY place Claude model aliases are resolved to ids. Mirrors `mapToClaudeMode`
 * (permissionMode.ts) at the SDK boundary. 'default', concrete ids, and undefined pass through.
 */
export function mapToClaudeModel(model: string | undefined): string | undefined {
    if (!model) {
        return model;
    }
    const aliasToModel: Record<string, string> = {
        opus: 'claude-opus-4-8',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5',
    };
    return aliasToModel[model] ?? model;
}
