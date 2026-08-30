import { describe, expect, it } from 'vitest';
import type { Session } from './storageTypes';
import { buildSessionResumeContext } from './resumeContext';

const metadata = {
    machineId: 'machine-1',
    path: '/workspace/project',
    flavor: 'codex',
    codexThreadId: 'thread-1',
} as NonNullable<Session['metadata']>;

const session = {
    metadata,
};

describe('buildSessionResumeContext', () => {
    it('combines decrypted session state with a base64 per-session data key', () => {
        const dataKey = new Uint8Array(32).fill(7);

        expect(buildSessionResumeContext(session, dataKey)).toEqual({
            encryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            encryptionVariant: 'dataKey',
        });
        expect(dataKey).toEqual(new Uint8Array(32).fill(7));
    });

    it('does not build context without a per-session data key', () => {
        expect(buildSessionResumeContext(session, undefined)).toBeUndefined();
        expect(buildSessionResumeContext(session, null)).toBeUndefined();
    });

    it('does not build context with a non-32-byte data key', () => {
        expect(buildSessionResumeContext(session, new Uint8Array(31))).toBeUndefined();
        expect(buildSessionResumeContext(session, new Uint8Array(33))).toBeUndefined();
    });

    it('does not build context when decrypted metadata is unavailable', () => {
        expect(buildSessionResumeContext({ ...session, metadata: null }, new Uint8Array(32))).toBeUndefined();
    });

    it.each([
        ['machine ID', { machineId: '' }],
        ['working path', { path: '' }],
        ['provider resume ID', { codexThreadId: undefined }],
    ])('does not build context without a usable %s', (_label, metadataPatch) => {
        expect(buildSessionResumeContext(
            { ...session, metadata: { ...metadata, ...metadataPatch } },
            new Uint8Array(32),
        )).toBeUndefined();
    });

    it('requires the resume ID that matches an explicit provider flavor', () => {
        expect(buildSessionResumeContext(
            {
                ...session,
                metadata: {
                    ...metadata,
                    flavor: 'claude',
                    claudeSessionId: undefined,
                },
            },
            new Uint8Array(32),
        )).toBeUndefined();
    });
});
