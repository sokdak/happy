/**
 * Map Happy's Claude model-mode aliases to explicit model ids before handing them to the
 * agent SDK.
 *
 * Why: the bundled `@anthropic-ai/claude-agent-sdk` runtime resolves bare aliases like `opus`
 * to an older generation than the UI advertises (e.g. `opus` -> a pre-5 Opus), so selecting
 * "opus 5" via an alias would silently produce a stale session. Passing the explicit id pins
 * the model the UI advertises, independent of the SDK's (possibly stale) alias table. `haiku`
 * currently resolves correctly but is pinned for the same reason — the picker is the source of
 * truth. The picker itself sends concrete ids for opus 5 / sonnet 5; these alias mappings cover
 * the default modelMode and any persisted `opus`/`sonnet` selections.
 *
 * This is the ONLY place Claude model aliases are resolved to ids. Mirrors `mapToClaudeMode`
 * (permissionMode.ts) at the SDK boundary. 'default', concrete ids, and undefined pass through.
 */
export function mapToClaudeModel(model: string | undefined): string | undefined {
    if (!model) {
        return model;
    }
    const aliasToModel: Record<string, string> = {
        opus: 'claude-opus-5',
        sonnet: 'claude-sonnet-5',
        haiku: 'claude-haiku-4-5',
    };
    return aliasToModel[model] ?? model;
}
