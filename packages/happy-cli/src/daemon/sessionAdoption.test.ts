import { describe, expect, it } from 'vitest';
import { restoreFinishedSessions, selectAdoptableSessions, selectExpiredFinishedSessions } from './sessionAdoption';
import type { PersistedSession } from '@/persistence';

const persisted = (
    hostPid: number | undefined,
    savedAt = 0,
    hostProcessStartToken?: string,
): PersistedSession => ({
    encryptionKey: 'key',
    encryptionVariant: 'dataKey',
    seq: 0,
    metadataVersion: 0,
    agentStateVersion: 0,
    metadata: { hostPid, hostProcessStartToken } as PersistedSession['metadata'],
    savedAt,
});

describe('selectAdoptableSessions', () => {
    it('adopts a persisted session whose process is still running', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([{ sessionId: 'session-a', pid: 4242 }]);
    });

    it('ignores a session whose process is gone', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([]);
    });

    it('ignores a pid that is alive but is not a happy process', () => {
        // The pid may have been recycled by the OS since it was persisted.
        // Only pids that a process scan still reports as happy are adoptable.
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242) },
            { liveHappyPids: [9999], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([]);
    });

    it('never adopts the daemon itself', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(777) },
            { liveHappyPids: [777], selfPid: 777, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([]);
    });

    it('skips a session that never reported a host pid', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(undefined) },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([]);
    });

    it('adopts neither session when two claim the same pid', () => {
        // Ambiguous: one of them is a stale record pointing at a recycled pid,
        // and adopting the wrong one would let a stop request kill a session
        // the user is still using.
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242), 'session-b': persisted(4242) },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => null },
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
            { liveHappyPids: [11, 33], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([
            { sessionId: 'session-a', pid: 11 },
            { sessionId: 'session-c', pid: 33 },
        ]);
    });
});


describe('selectAdoptableSessions process identity', () => {
    it('adopts when the recorded start token still matches the process', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242, 0, 'tick-100') },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => 'tick-100' },
        );

        expect(adopted).toEqual([{ sessionId: 'session-a', pid: 4242 }]);
    });

    it('refuses a pid whose process started at a different time', () => {
        // Same pid, different process: the original exited and the OS handed
        // the number to another happy session. Adopting it would let a stop
        // request for the old session kill the new one.
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242, 0, 'tick-100') },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => 'tick-999' },
        );

        expect(adopted).toEqual([]);
    });

    it('falls back to the pid check when the platform cannot report a token', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242, 0, 'tick-100') },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => null },
        );

        expect(adopted).toEqual([{ sessionId: 'session-a', pid: 4242 }]);
    });

    it('adopts records written before start tokens existed', () => {
        const adopted = selectAdoptableSessions(
            { 'session-a': persisted(4242, 0, undefined) },
            { liveHappyPids: [4242], selfPid: 1, startTokenForPid: () => 'tick-100' },
        );

        expect(adopted).toEqual([{ sessionId: 'session-a', pid: 4242 }]);
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

describe('restoreFinishedSessions', () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;

    it('dates a restored session from when it was persisted', () => {
        const savedAt = now - 3 * day;

        const restored = restoreFinishedSessions({ 'session-a': persisted(4242, savedAt) });

        expect(restored.get('session-a')?.finishedAt).toBe(savedAt);
    });

    it('keeps every session the disk copy still loads past the first heartbeat', () => {
        // readPersistedSessions() only returns records inside SESSION_MAX_AGE_MS,
        // so anything it hands back must survive the heartbeat that prunes the
        // same map at the same age. Restoring entries undated made that first
        // heartbeat delete all of them, and resume then reported every session
        // as "not tracked by this daemon" (sokdak/happy-helm#32).
        const restored = restoreFinishedSessions({
            'saved-today': persisted(1, now),
            'saved-13-days-ago': persisted(2, now - 13 * day),
        });

        const expired = selectExpiredFinishedSessions(
            Array.from(restored.entries()).map(([sessionId, session]) => ({
                sessionId,
                finishedAt: session.finishedAt,
            })),
            now,
            14 * day,
        );

        expect(expired).toEqual([]);
    });

    it('carries the encryption material a resume needs', () => {
        const restored = restoreFinishedSessions({ 'session-a': persisted(4242, now) });

        expect(restored.get('session-a')).toMatchObject({
            startedBy: 'persisted',
            happySessionId: 'session-a',
            pid: 0,
            encryption: {
                encryptionVariant: 'dataKey',
                seq: 0,
                metadataVersion: 0,
                agentStateVersion: 0,
            },
        });
    });
});
