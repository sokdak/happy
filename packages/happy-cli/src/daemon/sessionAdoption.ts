/**
 * Reattaching the daemon to sessions it can no longer see.
 *
 * A session registers itself with the daemon exactly once, over the
 * `/session-started` webhook, and never again. The daemon keeps that
 * registration only in memory. So any daemon restart - including the automatic
 * hand-off when an npm upgrade replaces `dist/index.mjs` - starts with an empty
 * `pidToTrackedSession` while the sessions it spawned keep running.
 *
 * That is worse than untidy. `stopSession()` resolves a session id by walking
 * that map, so once it is empty the app can no longer stop those sessions: they
 * vanish from the machine's session list and their "stop" requests fail as
 * "not found". Each upgrade stranded another generation, which is how one host
 * ended up running three generations of Codex app-server at once with nothing
 * able to reap them (sokdak/happy-helm#22).
 *
 * The pid needed to find them again is already on disk: the webhook persists
 * the session's metadata, and `metadata.hostPid` is part of it.
 */
import type { PersistedSession } from '@/persistence';

/**
 * Marks a session the daemon picked up from a previous daemon rather than
 * spawned or received over the webhook. Shared so the webhook handler can
 * recognise its own adopted records.
 */
export const ADOPTED_SESSION_LABEL = 'adopted after daemon restart';

export interface AdoptableSession {
    sessionId: string;
    pid: number;
}

export interface AdoptionEnvironment {
    /** Pids a process scan currently reports as happy processes. */
    liveHappyPids: Iterable<number>;
    /** The daemon's own pid, which is a happy process but not a session. */
    selfPid: number;
    /**
     * Start token for a live pid, or null where the platform cannot report one.
     * Compared against the token recorded when the session registered, so a
     * recycled pid running a *different* happy session is not mistaken for the
     * original.
     */
    startTokenForPid: (pid: number) => string | null;
}

export function selectAdoptableSessions(
    persisted: Record<string, PersistedSession>,
    { liveHappyPids, selfPid, startTokenForPid }: AdoptionEnvironment,
): AdoptableSession[] {
    const live = new Set(liveHappyPids);

    const candidates: AdoptableSession[] = [];
    const claimsPerPid = new Map<number, number>();

    for (const [sessionId, session] of Object.entries(persisted)) {
        const pid = session.metadata?.hostPid;

        // No pid was ever reported, the process is gone, or the pid belongs to
        // something that is not a happy process any more - the OS recycles pids,
        // and a persisted record can outlive the process it names.
        if (typeof pid !== 'number' || pid === selfPid || !live.has(pid)) {
            continue;
        }

        // Only a token that disagrees is disqualifying. A record from before
        // tokens existed, or a platform that cannot produce one, leaves the
        // check where it was rather than refusing to adopt anything.
        const recordedToken = session.metadata?.hostProcessStartToken;
        if (recordedToken) {
            const currentToken = startTokenForPid(pid);
            if (currentToken && currentToken !== recordedToken) {
                continue;
            }
        }

        candidates.push({ sessionId, pid });
        claimsPerPid.set(pid, (claimsPerPid.get(pid) ?? 0) + 1);
    }

    // Two records naming one pid means at least one of them is stale. Adopting
    // the wrong one would let a stop request kill a session someone is using,
    // so neither is adopted; they stay unmanaged exactly as they are today.
    return candidates.filter(({ pid }) => claimsPerPid.get(pid) === 1);
}

export interface FinishedSessionEntry {
    sessionId: string;
    finishedAt?: number;
}

/**
 * The daemon keeps finished sessions in memory so a resume can still find their
 * encryption keys, and nothing ever removed them - the map grew for as long as
 * the daemon lived. The on-disk copy is already pruned at the same age
 * (`SESSION_MAX_AGE_MS`), so an entry older than that cannot serve a resume
 * anyway.
 */
export function selectExpiredFinishedSessions(
    entries: FinishedSessionEntry[],
    now: number,
    maxAgeMs: number,
): string[] {
    return entries
        // An entry with no timestamp predates this bookkeeping. Keeping it
        // forever is the leak; the disk copy still backs any resume it served.
        .filter(({ finishedAt }) => finishedAt === undefined || now - finishedAt > maxAgeMs)
        .map(({ sessionId }) => sessionId);
}
