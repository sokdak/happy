/**
 * Identifying one *run* of a process, not just its number.
 *
 * The daemon re-adopts sessions after a restart by pid, and a pid alone is not
 * an identity: the OS recycles them, so a persisted record can name a pid that
 * now belongs to a different process. Checking that the pid is still a happy
 * process closes most of that gap but not the case that matters - another happy
 * session landing on the recycled number - where adopting the wrong one lets a
 * stop request for the old session terminate a session someone is using.
 *
 * Linux exposes a start time per process, which together with the pid names one
 * run. Other platforms have equivalents that all need a subprocess, so they
 * return null and adoption falls back to the pid check it did before.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Field 22 of /proc/<pid>/stat, the start time in clock ticks since boot.
 *
 * Exported for tests: the parsing is the part worth pinning. `comm` (field 2)
 * is wrapped in parentheses but not escaped, so a process named
 * `happy (codex) session` shifts every field if you split from the left.
 */
export function parseProcStatStartTime(content: string): string | null {
    const commEnd = content.lastIndexOf(')');
    if (commEnd === -1) {
        return null;
    }

    // Fields after `comm` start at 3 (state), so field 22 sits at index 19.
    const fields = content.slice(commEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

export function processStartToken(pid: number): string | null {
    if (os.platform() !== 'linux') {
        return null;
    }

    try {
        return parseProcStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf-8'));
    } catch {
        // Process gone, or /proc not mounted. Unknown, not "different".
        return null;
    }
}
