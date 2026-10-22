import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { parseClaudeAiTitleTranscriptEvent, type ClaudeAiTitleTranscriptEvent } from "../claudeAiTitle";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'file-history-delta',
    'change',
    'queue-operation',
    'last-prompt',
    'relocated',
    'mode',
    'permission-mode',
    'pr-link',
    'worktree-state',
]);

export type ScannerTranscriptEvent =
    | ClaudeGoalStatusTranscriptEvent
    | ClaudeAiTitleTranscriptEvent;

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent };

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /**
     * How long the transcript's parent directory may stay unwatchable before
     * its watcher gives up. This does not bound a late transcript file.
     */
    missingFileTimeoutMs?: number
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedEntryKeys = new Set<string>();
    // Every rescan re-reads the whole transcript. Cap parse/schema diagnostics
    // per session file for this scanner's life.
    let loggedTranscriptDiagnostics = new Set<string>();
    // Sessions whose project directory stayed unwatchable. Their watcher gave
    // up, so do not keep re-creating it on every sync. A merely absent file is
    // watched through its parent directory and never enters this set.
    let deadSessions = new Set<string>();

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = await readSessionEntries(projectDir, opts.sessionId, loggedTranscriptDiagnostics);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionEntries = await readSessionEntries(projectDir, session, loggedTranscriptDiagnostics);
            let skipped = 0;
            let sentMessages = 0;
            let sentTranscriptEvents = 0;
            for (let entry of sessionEntries) {
                if (processedEntryKeys.has(entry.key)) {
                    skipped++;
                    continue;
                }
                processedEntryKeys.add(entry.key);
                if (entry.kind === 'message') {
                    logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
                    opts.onMessage(entry.message);
                    sentMessages++;
                } else {
                    logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, key=${entry.key}`);
                    opts.onTranscriptEvent?.(entry.event);
                    sentTranscriptEvents++;
                }
            }
            if (sessionEntries.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionEntries.length}, skipped=${skipped}, sentMessages=${sentMessages}, sentTranscriptEvents=${sentTranscriptEvents}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p) && !deadSessions.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(
                    join(projectDir, `${p}.jsonl`),
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The project directory stayed unwatchable. Tear
                            // down and blacklist the session so the collection
                            // loop does not resurrect the failed watcher.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript unreachable (directory unwatchable) — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            // The final sync can create watchers, so flush and stop before
            // disposing the map. Otherwise cleanup can leak newly-created
            // directory watchers.
            await sync.invalidateAndAwait();
            sync.stop();
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            loggedTranscriptDiagnostics.clear();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            const wasDead = deadSessions.delete(sessionId);
            if (wasDead) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (currentSessionId === sessionId) {
                if (wasDead) {
                    // A re-announced current session may have been dropped
                    // while its directory was unavailable. Do not let the
                    // same-id fast path prevent its watcher from returning.
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                }
                return;
            }
            if (!wasDead && finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (!wasDead && pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            // When the caller already has these messages (typical for
            // happy-reconnect — the server holds the history from prior
            // turns and metadata.claudeSessionId simply hadn't propagated
            // by the time we built the scanner), pre-mark whatever is on
            // disk so the first invalidate() does not replay the entire
            // file as fresh user prompts. Without this, every previous
            // user message re-appears in the chat after reconnect.
            if (options?.treatExistingAsProcessed) {
                const existing = await readSessionEntries(projectDir, sessionId, loggedTranscriptDiagnostics);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    processedEntryKeys.add(entry.key);
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

function transcriptEventKey(event: ScannerTranscriptEvent): string {
    // ai-title lines carry no uuid — key them by session + title so an
    // unchanged line dedupes across rescans while a rename emits again.
    if (event.type === 'ai_title') {
        return `event:aititle:${event.sourceRevision}`;
    }
    return `event:${event.uuid}`;
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages and recognized side-channel events,
 * silently skipping internal events.
 */
async function readSessionEntries(
    projectDir: string,
    sessionId: string,
    loggedTranscriptDiagnostics: Set<string>,
): Promise<SessionLogEntry[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let entries: SessionLogEntry[] = [];
    for (let l of lines) {
        if (l.trim() === '') {
            continue;
        }

        let message: any;
        try {
            message = JSON.parse(l);
        } catch (error) {
            const loggedKey = `${expectedSessionFile}:malformed-json`;
            if (!loggedTranscriptDiagnostics.has(loggedKey)) {
                loggedTranscriptDiagnostics.add(loggedKey);
                logger.debug(
                    `[SESSION_SCANNER] Skipping malformed JSON transcript lines `
                    + `(further malformed lines in this file are silent): ${error}`,
                );
            }
            continue;
        }

        try {
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (typeof message?.type === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(message)
                ?? parseClaudeAiTitleTranscriptEvent(message);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: transcriptEventKey(transcriptEvent),
                    event: transcriptEvent,
                });
                continue;
            }

            // An 'ai-title' line that did not parse above is missing the title
            // or the session id — still a known bookkeeping line, so skip it
            // silently instead of letting it reach the schema check below.
            if (message?.type === 'ai-title') {
                continue;
            }

            // Non-goal attachment lines are expected Claude bookkeeping. Goal
            // status attachments have already been extracted above.
            if (message?.type === 'attachment') {
                continue;
            }

            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                const lineType = typeof message?.type === 'string' ? message.type : 'unknown';
                const loggedKey = `${expectedSessionFile}:${lineType}`;
                if (!loggedTranscriptDiagnostics.has(loggedKey)) {
                    loggedTranscriptDiagnostics.add(loggedKey);
                    const issues = parsed.error.issues
                        .slice(0, 3)
                        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                        .join('; ');
                    logger.debug(
                        `[SESSION_SCANNER] Skipping transcript lines failing schema validation `
                        + `(further lines of this type in this file are silent): type=${lineType} — ${issues}`,
                    );
                }
                continue;
            }
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            const lineType = typeof message?.type === 'string' ? message.type : 'unknown';
            const loggedKey = `${expectedSessionFile}:processing-error:${lineType}`;
            if (!loggedTranscriptDiagnostics.has(loggedKey)) {
                loggedTranscriptDiagnostics.add(loggedKey);
                logger.debug(
                    `[SESSION_SCANNER] Error processing transcript lines `
                    + `(further errors of this type in this file are silent): type=${lineType} — ${e}`,
                );
            }
            continue;
        }
    }
    return entries;
}
