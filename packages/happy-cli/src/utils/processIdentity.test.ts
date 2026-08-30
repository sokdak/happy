import { describe, expect, it } from 'vitest';
import { parseProcStatStartTime } from './processIdentity';

// Field 22 of /proc/<pid>/stat is the process start time in clock ticks since
// boot. Together with the pid it identifies one process run: a recycled pid
// gets a different start time.
const statLine = (comm: string, startTime: string) =>
    `4242 (${comm}) S 1 4242 4242 0 -1 4194560 1234 0 0 0 12 3 0 0 20 0 5 0 ${startTime} 123456789 4321 18446744073709551615`;

describe('parseProcStatStartTime', () => {
    it('reads the start time field', () => {
        expect(parseProcStatStartTime(statLine('node', '987654'))).toBe('987654');
    });

    it('survives a process name containing spaces and parentheses', () => {
        // comm is not escaped in /proc, so anything before the LAST ')' is the
        // name - splitting on whitespace from the left silently shifts fields.
        expect(parseProcStatStartTime(statLine('happy (codex) session', '987654'))).toBe('987654');
    });

    it('returns null when the line has too few fields', () => {
        expect(parseProcStatStartTime('4242 (node) S 1 4242')).toBeNull();
    });

    it('returns null for something that is not a stat line', () => {
        expect(parseProcStatStartTime('')).toBeNull();
        expect(parseProcStatStartTime('not a stat line')).toBeNull();
    });
});
