/**
 * Reasoning effort vocabularies, per agent.
 *
 * These look interchangeable and are not. Codex has `none` and `minimal` below
 * Claude's floor and `ultra` above its ceiling. Only
 * `low | medium | high | xhigh | max` is common ground.
 *
 * The difference matters wherever a request crosses agents - the daemon coerces
 * a spawn for a disabled agent onto an enabled one, and forwarding `--effort
 * max` to Codex launches it with a level its own validation rejects.
 *
 * Kept in one place because the lists had already drifted apart: the parser,
 * the Codex type, and the help text each carried their own copy.
 */

export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Mirrors codex-rs `protocol/src/openai_models.rs` ReasoningEffort: gpt-5.6
// sol/terra publish `ultra`, luna stops at `max`.
export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number];

export type CodexEffortLevel = typeof CODEX_EFFORT_LEVELS[number];

// Only these two agents are ever launched with --effort; the daemon returns
// early for the rest.
const EFFORT_LEVELS_BY_AGENT: Record<string, readonly string[]> = {
    claude: CLAUDE_EFFORT_LEVELS,
    codex: CODEX_EFFORT_LEVELS,
};

export function agentSupportsEffortLevel(agent: string, effortLevel: string): boolean {
    return EFFORT_LEVELS_BY_AGENT[agent]?.includes(effortLevel) ?? false;
}
