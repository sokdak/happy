/**
 * Log retention.
 *
 * Every CLI and daemon start opens its own log file and nothing ever removed
 * them. On a host running the daemon under systemd for three months that grew
 * to 204,264 files / 924MB (sokdak/happy-helm#22): restarting the daemon
 * reclaimed the processes but never the logs.
 *
 * Pruning runs on start, is bounded, and is best effort - a log directory we
 * cannot read or a file we cannot remove must never keep the CLI from starting.
 */
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_RETENTION_DAYS = 14;

// A backlog can be six figures. Deleting it in one pass would make the first
// start after an upgrade pay for months of accumulation, so each run takes a
// bite and the oldest files go first.
const DEFAULT_DELETE_LIMIT = 2_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Written by createTimestampForFilename(): a local-time stamp, the pid, and an
// optional -daemon marker. The pid segment is optional because a long-lived
// logs directory also holds files from before it was added to the name, and
// those are exactly the oldest ones worth clearing.
const LOG_FILE_NAME = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-pid-\d+)?(?:-daemon)?\.log$/;

export function parseLogFileTimestamp(filename: string): number | null {
    const match = LOG_FILE_NAME.exec(filename);
    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute, second] = match;
    // The name was formatted in local time, so read it back in local time.
    const at = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    ).getTime();

    return Number.isNaN(at) ? null : at;
}

export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.HAPPY_LOG_RETENTION_DAYS;
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_RETENTION_DAYS;
    }

    const days = Number(raw);
    // Deletion is not the place to guess. A value we cannot read falls back to
    // the documented default rather than to "keep nothing".
    if (!Number.isFinite(days) || days < 0) {
        return DEFAULT_RETENTION_DAYS;
    }

    return Math.floor(days);
}

export interface SelectExpiredLogsOptions {
    now: number;
    retentionDays: number;
    /** The file this process is writing to; never a deletion candidate. */
    currentFile?: string;
    limit?: number;
}

export function selectExpiredLogFiles(
    filenames: string[],
    options: SelectExpiredLogsOptions,
): string[] {
    const { now, retentionDays, currentFile, limit = DEFAULT_DELETE_LIMIT } = options;
    if (retentionDays <= 0) {
        return [];
    }

    const cutoff = now - retentionDays * MS_PER_DAY;

    return filenames
        .filter((name) => name !== currentFile)
        .map((name) => ({ name, at: parseLogFileTimestamp(name) }))
        // A file whose name we do not recognise is not ours to delete. The log
        // directory is a path the user can point elsewhere.
        .filter((entry): entry is { name: string; at: number } => entry.at !== null && entry.at < cutoff)
        .sort((a, b) => a.at - b.at)
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.name);
}

/**
 * Remove expired log files. Returns how many were removed.
 *
 * Never throws: pruning is a background chore, not a startup dependency.
 */
export async function pruneOldLogs(
    logsDir: string,
    currentFile?: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    try {
        const retentionDays = resolveRetentionDays(env);
        if (retentionDays <= 0) {
            return 0;
        }

        const entries = await readdir(logsDir);
        const expired = selectExpiredLogFiles(entries, {
            now: Date.now(),
            retentionDays,
            currentFile,
        });

        let removed = 0;
        for (const name of expired) {
            try {
                await unlink(join(logsDir, name));
                removed += 1;
            } catch {
                // Raced with another happy process, or not ours to remove.
            }
        }
        return removed;
    } catch {
        return 0;
    }
}
