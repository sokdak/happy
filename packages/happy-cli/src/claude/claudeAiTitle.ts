/**
 * Claude Code writes an `ai-title` transcript line once it has named a
 * conversation:
 *
 *   {"type":"ai-title","aiTitle":"Fix the flaky scanner test","sessionId":"..."}
 *
 * Happy already has exactly one way to title a session — the synthetic
 * `summary` message the `change_title` MCP tool sends (see
 * `utils/startHappyServer.ts`), whose side effect writes `metadata.summary`.
 * This module only decides *whether* an observed ai-title should be applied;
 * the caller performs the send so the persistence path stays shared.
 */

export type ClaudeAiTitleTranscriptEvent = {
    type: 'ai_title';
    aiTitle: string;
    sourceSessionId: string;
    /**
     * Identity of this observation. ai-title lines carry no uuid, so the
     * session id plus the title itself is what distinguishes "the same line
     * seen again on a rescan" from "Claude renamed the conversation".
     */
    sourceRevision: string;
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function parseClaudeAiTitleTranscriptEvent(value: unknown): ClaudeAiTitleTranscriptEvent | null {
    const message = record(value);
    if (!message || message.type !== 'ai-title') {
        return null;
    }

    const aiTitle = nonEmptyString(message.aiTitle);
    const sourceSessionId = nonEmptyString(message.sessionId);
    if (!aiTitle || !sourceSessionId) {
        return null;
    }

    return {
        type: 'ai_title',
        aiTitle,
        sourceSessionId,
        sourceRevision: `${sourceSessionId}:${aiTitle}`,
    };
}

export type ClaudeAiTitleApplierOptions = {
    /** Live Claude session id, as tracked in session metadata. */
    getClaudeSessionId: () => string | null | undefined;
    /** Title the Happy session currently carries (`metadata.summary?.text`). */
    getCurrentTitle: () => string | null | undefined;
    /** Performs the actual title write — the synthetic `summary` message. */
    applyTitle: (title: string) => void;
};

/**
 * Builds the ai-title handler: dedupes repeated observations, ignores events
 * belonging to a different Claude session, and yields to any title the session
 * already has (an explicit `change_title` must never be clobbered by Claude's
 * own naming).
 */
export function createClaudeAiTitleApplier(
    opts: ClaudeAiTitleApplierOptions,
): (event: ClaudeAiTitleTranscriptEvent) => void {
    const observedRevisions = new Set<string>();
    // The title write is not visible to `getCurrentTitle` right away: sending
    // the synthetic summary only queues a metadata update, which apiSession
    // applies locally after the server acks it. A cold scan emits every
    // ai-title line in the transcript back to back, well inside that window,
    // so remember what we sent — otherwise a later line would read "no title"
    // and clobber the one we just set.
    let titleInFlight: string | null = null;

    return (event: ClaudeAiTitleTranscriptEvent) => {
        if (observedRevisions.has(event.sourceRevision)) {
            return;
        }

        // Mirrors the goal-status guard: only drop when we actually know which
        // Claude session is live and it is a different one.
        const claudeSessionId = opts.getClaudeSessionId();
        if (claudeSessionId && event.sourceSessionId !== claudeSessionId) {
            return;
        }

        // Precedence: the session keeps whatever title it already has.
        const currentTitle = nonEmptyString(opts.getCurrentTitle()) ?? titleInFlight;
        if (currentTitle) {
            return;
        }

        observedRevisions.add(event.sourceRevision);
        titleInFlight = event.aiTitle;
        opts.applyTitle(event.aiTitle);
    };
}
