import { describe, expect, it } from 'vitest';
import { parseLogFileTimestamp, resolveRetentionDays, selectExpiredLogFiles } from './logRetention';

const at = (iso: string) => new Date(iso).getTime();

describe('parseLogFileTimestamp', () => {
    it('reads the local timestamp a session log is named after', () => {
        const parsed = parseLogFileTimestamp('2026-08-01-12-30-00-pid-1234.log');

        expect(parsed).not.toBeNull();
        expect(new Date(parsed!).getFullYear()).toBe(2026);
        expect(new Date(parsed!).getMonth()).toBe(7);
        expect(new Date(parsed!).getDate()).toBe(1);
        expect(new Date(parsed!).getHours()).toBe(12);
    });

    it('reads the daemon variant of the same name', () => {
        expect(parseLogFileTimestamp('2026-08-01-12-30-00-pid-1234-daemon.log')).not.toBeNull();
    });

    it('reads the older name that predates the pid segment', () => {
        expect(parseLogFileTimestamp('2026-08-01-12-30-00.log')).not.toBeNull();
        expect(parseLogFileTimestamp('2026-08-01-12-30-00-daemon.log')).not.toBeNull();
    });

    it('returns null for anything it does not recognise', () => {
        expect(parseLogFileTimestamp('notes.txt')).toBeNull();
        expect(parseLogFileTimestamp('happy.log')).toBeNull();
        expect(parseLogFileTimestamp('2026-08-01.log')).toBeNull();
    });
});

describe('resolveRetentionDays', () => {
    it('defaults to two weeks', () => {
        expect(resolveRetentionDays({})).toBe(14);
    });

    it('takes an explicit override', () => {
        expect(resolveRetentionDays({ HAPPY_LOG_RETENTION_DAYS: '3' })).toBe(3);
    });

    it('treats 0 as "keep everything"', () => {
        expect(resolveRetentionDays({ HAPPY_LOG_RETENTION_DAYS: '0' })).toBe(0);
    });

    it('falls back to the default rather than acting on a value it cannot read', () => {
        expect(resolveRetentionDays({ HAPPY_LOG_RETENTION_DAYS: 'forever' })).toBe(14);
        expect(resolveRetentionDays({ HAPPY_LOG_RETENTION_DAYS: '-5' })).toBe(14);
    });
});

describe('selectExpiredLogFiles', () => {
    const now = at('2026-08-26T12:00:00');

    it('selects only the files older than the retention window', () => {
        const expired = selectExpiredLogFiles(
            ['2026-08-01-09-00-00-pid-1.log', '2026-08-25-09-00-00-pid-2.log'],
            { now, retentionDays: 14 },
        );

        expect(expired).toEqual(['2026-08-01-09-00-00-pid-1.log']);
    });

    it('never selects the log the current process is writing to', () => {
        const current = '2026-01-01-09-00-00-pid-9.log';

        const expired = selectExpiredLogFiles([current], { now, retentionDays: 14, currentFile: current });

        expect(expired).toEqual([]);
    });

    it('leaves files it cannot date alone', () => {
        const expired = selectExpiredLogFiles(
            ['README.md', 'happy.log', '2026-08-01-09-00-00-pid-1.log'],
            { now, retentionDays: 14 },
        );

        expect(expired).toEqual(['2026-08-01-09-00-00-pid-1.log']);
    });

    it('includes daemon logs', () => {
        const expired = selectExpiredLogFiles(
            ['2026-08-01-09-00-00-pid-1-daemon.log'],
            { now, retentionDays: 14 },
        );

        expect(expired).toEqual(['2026-08-01-09-00-00-pid-1-daemon.log']);
    });

    it('selects nothing when retention is disabled', () => {
        const expired = selectExpiredLogFiles(
            ['2020-01-01-09-00-00-pid-1.log'],
            { now, retentionDays: 0 },
        );

        expect(expired).toEqual([]);
    });

    it('takes the whole backlog when no cap is given', () => {
        const names = Array.from({ length: 50 }, (_, i) => `2026-08-0${(i % 9) + 1}-09-00-0${i % 10}-pid-${i}.log`);

        const expired = selectExpiredLogFiles(names, { now, retentionDays: 14 });

        expect(expired).toHaveLength(50);
    });

    it('honours an explicit cap on one run', () => {
        const names = Array.from({ length: 50 }, (_, i) => `2026-08-0${(i % 9) + 1}-09-00-0${i % 10}-pid-${i}.log`);

        const expired = selectExpiredLogFiles(names, { now, retentionDays: 14, limit: 10 });

        expect(expired).toHaveLength(10);
    });

    it('deletes the oldest first when it has to cap', () => {
        const expired = selectExpiredLogFiles(
            ['2026-08-05-09-00-00-pid-2.log', '2026-07-01-09-00-00-pid-1.log'],
            { now, retentionDays: 14, limit: 1 },
        );

        expect(expired).toEqual(['2026-07-01-09-00-00-pid-1.log']);
    });
});
