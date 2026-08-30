import { encodeBase64, encrypt } from '@/api/encryption';
import { describe, expect, it } from 'vitest';
import {
    persistedSessionFromResumeContext,
    RECONNECT_FORCE_HYDRATION_VERSION,
} from './resumeContext';

const DATA_KEY = new Uint8Array(32).fill(7);
const ENCODED_DATA_KEY = encodeBase64(DATA_KEY);

const validContext = () => ({
    encryptionKey: ENCODED_DATA_KEY,
    encryptionVariant: 'dataKey' as const,
});

const validMetadata = () => ({
    path: '/work/happy',
    host: 'workstation',
    homeDir: '/home/test',
    happyHomeDir: '/home/test/.happy',
    happyLibDir: '/home/test/.happy/lib',
    happyToolsDir: '/home/test/.happy/tools',
    machineId: 'machine-a',
    flavor: 'codex',
    codexThreadId: 'thread-123',
    hostPid: 4242,
    hostProcessStartToken: 'old-process-start',
});

const encryptedMetadata = (metadata: unknown, key: Uint8Array = DATA_KEY) => (
    encodeBase64(encrypt(key, 'dataKey', metadata))
);

const validServerSession = (overrides: Record<string, unknown> = {}) => ({
    id: 'session-a',
    seq: 41,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    active: false,
    activeAt: 1_700_000_050_000,
    metadata: encryptedMetadata(validMetadata()),
    metadataVersion: 7,
    agentState: null,
    agentStateVersion: 9,
    dataEncryptionKey: encodeBase64(new Uint8Array(48).fill(3)),
    lastMessage: null,
    ...overrides,
});

describe('persistedSessionFromResumeContext', () => {
    it('decrypts the authoritative server record and rebuilds safe local resume data', () => {
        const restored = persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession(),
            123_456,
        );

        expect(restored).toEqual({
            encryptionKey: ENCODED_DATA_KEY,
            encryptionVariant: 'dataKey',
            seq: 41,
            metadataVersion: RECONNECT_FORCE_HYDRATION_VERSION,
            agentStateVersion: RECONNECT_FORCE_HYDRATION_VERSION,
            metadata: {
                path: '/work/happy',
                host: 'workstation',
                homeDir: '/home/test',
                happyHomeDir: '/home/test/.happy',
                happyLibDir: '/home/test/.happy/lib',
                happyToolsDir: '/home/test/.happy/tools',
                machineId: 'machine-a',
                flavor: 'codex',
                codexThreadId: 'thread-123',
            },
            savedAt: 123_456,
        });
    });

    it('uses the hydration sentinel even when both server versions are zero', () => {
        const restored = persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({ metadataVersion: 0, agentStateVersion: 0 }),
        );

        expect(restored.metadataVersion).toBe(-1);
        expect(restored.agentStateVersion).toBe(-1);
    });

    it('removes stale process identity from recovered metadata', () => {
        const restored = persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession(),
        );

        expect(restored.metadata).not.toHaveProperty('hostPid');
        expect(restored.metadata).not.toHaveProperty('hostProcessStartToken');
    });

    it('rejects a server record for a different session ID', () => {
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({ id: 'session-b' }),
        )).toThrow('server returned a different session');
    });

    it('rejects decrypted metadata for a different machine', () => {
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({
                metadata: encryptedMetadata({ ...validMetadata(), machineId: 'machine-b' }),
            }),
        )).toThrow('belongs to a different machine');
    });

    it.each([
        ['non-base64 data', 'not-base64'],
        ['a short key', encodeBase64(new Uint8Array(31))],
        ['a long key', encodeBase64(new Uint8Array(33))],
    ])('rejects %s without exposing the supplied key', (_label, encryptionKey) => {
        let thrown: unknown;
        try {
            persistedSessionFromResumeContext(
                'session-a',
                'machine-a',
                { ...validContext(), encryptionKey },
                validServerSession(),
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('invalid session encryption key');
        expect((thrown as Error).message).not.toContain(encryptionKey);
    });

    it('rejects a wrong canonical key without exposing it', () => {
        const wrongKey = encodeBase64(new Uint8Array(32).fill(8));
        let thrown: unknown;
        try {
            persistedSessionFromResumeContext(
                'session-a',
                'machine-a',
                { ...validContext(), encryptionKey: wrongKey },
                validServerSession(),
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('could not be decrypted');
        expect((thrown as Error).message).not.toContain(wrongKey);
    });

    const malformedInputs: Array<[string, { context?: unknown; server?: unknown }]> = [
        ['legacy app context', { context: { ...validContext(), encryptionVariant: 'legacy' } }],
        ['extra app context fields', { context: { ...validContext(), metadata: validMetadata() } }],
        ['negative sequence', { server: validServerSession({ seq: -1 }) }],
        ['missing sequence', { server: validServerSession({ seq: undefined }) }],
        ['negative metadata version', { server: validServerSession({ metadataVersion: -1 }) }],
        ['fractional agent-state version', { server: validServerSession({ agentStateVersion: 1.5 }) }],
    ];

    it.each(malformedInputs)('rejects malformed recovery input: %s', (_label, patch) => {
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            patch.context ?? validContext(),
            patch.server ?? validServerSession(),
        )).toThrow(/malformed/);
    });

    it('allows additive server response fields and last-message changes', () => {
        const restored = persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({
                lastMessage: { id: 'message-1' },
                futureServerField: true,
            }),
        );

        expect(restored.seq).toBe(41);
    });

    it('requires an authoritative per-session encryption record', () => {
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({ dataEncryptionKey: null }),
        )).toThrow('does not use per-session encryption');
    });

    it.each([
        ['missing path', { path: '' }],
        ['missing provider resume ID', { codexThreadId: undefined }],
        ['mismatched provider resume ID', {
            flavor: 'claude',
            claudeSessionId: undefined,
        }],
    ])('rejects decrypted metadata with %s', (_label, metadataPatch) => {
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({
                metadata: encryptedMetadata({ ...validMetadata(), ...metadataPatch }),
            }),
        )).toThrow(/metadata|session ID/);
    });

    it('rejects non-canonical server ciphertext before decrypting it', () => {
        const nonCanonical = `${encryptedMetadata(validMetadata())}=`;
        expect(() => persistedSessionFromResumeContext(
            'session-a',
            'machine-a',
            validContext(),
            validServerSession({ metadata: nonCanonical }),
        )).toThrow('server session metadata is malformed');
    });
});
