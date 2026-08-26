import { describe, expect, it } from 'vitest';
import { selectAdoptableSessions, selectExpiredFinishedSessions } from './sessionAdoption';
import type { PersistedSession } from '@/persistence';

const persisted = (hostPid: number | undefined, savedAt = 0): PersistedSession => ({
    encryptionKey: 'key',
    encryptionVariant: 'dataKey',
    seq: 0,
    metadataVersion: 0,
    agentStateVersion: 0,
    metadata: { hostPid } as PersistedSession['metadata'],
    savedAt,
});

describe('selectAdoptableSessions', () => {
    it('adopts a persisted session whose process is still running', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [4242], selfPid: 1 },
        );

        expect(adopted).toEqual([{ sessionId: 'session-a', pid: 4242 }]);
    });

    it('ignores a session whose process is gone', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [], selfPid: 1 },
        );

        expect(adopted).toEqual([]);
    });

    it('ignores a pid that is alive but is not a happy process', () => {
        // The pid may have been recycled by the OS since it was persisted.
        // Only pids that a process scan still reports as happy are adoptable.
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [9999], selfPid: 1 },
        );

        expect(adopted).toEqual([]);
    });

    it('never adopts the daemon itself', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(777) },
            { liveHappyPids: [777], selfPid: 777 },
        );

        expect(adopted).toEqual([]);
    });

    it('skips a session that never reported a host pid', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(undefined) },
            { liveHappyPids: [4242], selfPid: 1 },
        );

        expect(adopted).toEqual([]);
    });

    it('adopts neither session when two claim the same pid', () => {
        // Ambiguous: one of them is a stale record pointing at a recycled pid,
        // and adopting the wrong one would let a stop request kill a session
        // the user is still using.
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242), 'session-b': persisted(4242) },
            { liveHappyPids: [4242], selfPid: 1 },
        );

        expect(adopted).toEqual([]);
    });

    it('adopts every live session it can identify', () => {
        const adopted = selectAdoptableSessions(
            {
                'session-a': persisted(11),
                'session-b': persisted(22),
                'session-c': persisted(33),
            },
            { liveHappyPids: [11, 33], selfPid: 1 },
        );

        expect(adopted).toEqual([
            { sessionId: 'session-a', pid: 11 },
            { sessionId: 'session-c', pid: 33 },
        ]);
    });
});

describe('selectExpiredFinishedSessions', () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    it('drops entries older than the retention window', () => {
        const expired = selectExpiredFinishedSessions(
            [
                { sessionId: 'old', finishedAt: now - 15 * day },
                { sessionId: 'recent', finishedAt: now - day },
            ],
            now,
            14 * day,
        );

        expect(expired).toEqual(['old']);
    });

    it('keeps an entry exactly at the boundary', () => {
        const expired = selectExpiredFinishedSessions(
            [{ sessionId: 'edge', finishedAt: now - 14 * day }],
            now,
            14 * day,
        );

        expect(expired).toEqual([]);
    });

    it('drops an entry with no timestamp rather than keeping it forever', () => {
        const expired = selectExpiredFinishedSessions(
            [{ sessionId: 'undated', finishedAt: undefined }],
            now,
            14 * day,
        );

        expect(expired).toEqual(['undated']);
    });

    it('returns nothing for an empty map', () => {
        expect(selectExpiredFinishedSessions([], now, 14 * day)).toEqual([]);
    });
});
