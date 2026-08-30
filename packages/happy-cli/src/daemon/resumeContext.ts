import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { PersistedSession } from '@/persistence';
import { z } from 'zod';

const NonBlankStringSchema = z.string().refine((value) => value.trim().length > 0);

const ResumeMetadataSchema = z.object({
    path: NonBlankStringSchema,
    machineId: NonBlankStringSchema,
    flavor: z.string().nullish(),
    claudeSessionId: NonBlankStringSchema.optional(),
    codexThreadId: NonBlankStringSchema.optional(),
}).passthrough();

export const ResumeSessionContextSchema = z.object({
    encryptionKey: z.string().min(1),
    encryptionVariant: z.literal('dataKey'),
}).strict();

export const ResumeServerSessionSchema = z.object({
    id: NonBlankStringSchema,
    seq: z.number().int().nonnegative(),
    metadata: z.string().min(1),
    metadataVersion: z.number().int().nonnegative(),
    agentStateVersion: z.number().int().nonnegative(),
    dataEncryptionKey: z.string().min(1).nullable(),
}).passthrough();

export type ResumeSessionContext = z.infer<typeof ResumeSessionContextSchema>;
export type ResumeServerSession = z.infer<typeof ResumeServerSessionSchema>;

export const RECONNECT_FORCE_HYDRATION_VERSION = -1;

export type ResumeSessionOptions = {
    model?: string;
    permissionMode?: string;
    resumeContext?: ResumeSessionContext;
};

function invalidContext(sessionId: string, detail: string): Error {
    return new Error(
        `Cannot recover Happy session ${sessionId}: ${detail}. Refresh the app and try again.`,
    );
}

function decodeCanonicalDataKey(sessionId: string, encoded: string): Uint8Array {
    if (encoded.length !== 44) {
        throw invalidContext(sessionId, 'the resume recovery data contains an invalid session encryption key');
    }

    const decoded = decodeBase64(encoded);
    if (decoded.length !== 32 || encodeBase64(decoded) !== encoded) {
        throw invalidContext(sessionId, 'the resume recovery data contains an invalid session encryption key');
    }
    return decoded;
}

function isCanonicalBase64(encoded: string): boolean {
    const decoded = decodeBase64(encoded);
    return decoded.length > 0 && encodeBase64(decoded) === encoded;
}

/**
 * Rebuild a locally persisted resume record from a minimal app-supplied data
 * key and the exact session record fetched by the daemon with its own account
 * credentials.
 *
 * The authenticated AES-GCM metadata ciphertext binds the supplied key to the
 * server record. Legacy account-wide keys are never accepted. The returned
 * versions use a recovery-only sentinel so the reconnect client's first
 * update receives a version mismatch and hydrates current server state — even
 * when the current server version is zero — instead of overwriting it with an
 * empty initial object.
 */
export function persistedSessionFromResumeContext(
    sessionId: string,
    expectedMachineId: string,
    rawContext: unknown,
    rawServerSession: unknown,
    savedAt: number = Date.now(),
): PersistedSession {
    const contextResult = ResumeSessionContextSchema.safeParse(rawContext);
    if (!contextResult.success) {
        throw invalidContext(sessionId, 'the resume recovery data is malformed');
    }

    const dataKey = decodeCanonicalDataKey(sessionId, contextResult.data.encryptionKey);

    const serverResult = ResumeServerSessionSchema.safeParse(rawServerSession);
    if (!serverResult.success) {
        throw invalidContext(sessionId, 'the server session record is malformed');
    }

    const serverSession = serverResult.data;
    if (serverSession.id !== sessionId) {
        throw invalidContext(sessionId, 'the server returned a different session');
    }
    if (!serverSession.dataEncryptionKey || !isCanonicalBase64(serverSession.dataEncryptionKey)) {
        throw invalidContext(sessionId, 'the server session does not use per-session encryption');
    }
    if (!isCanonicalBase64(serverSession.metadata)) {
        throw invalidContext(sessionId, 'the server session metadata is malformed');
    }

    const decrypted = decrypt(dataKey, 'dataKey', decodeBase64(serverSession.metadata));
    if (decrypted === null) {
        throw invalidContext(sessionId, 'the session metadata could not be decrypted');
    }

    const metadataResult = ResumeMetadataSchema.safeParse(decrypted);
    if (!metadataResult.success) {
        throw invalidContext(sessionId, 'the decrypted session metadata is malformed');
    }

    const metadata = metadataResult.data;
    if (metadata.machineId !== expectedMachineId) {
        throw invalidContext(sessionId, 'the session belongs to a different machine');
    }

    const hasCodexThread = Boolean(metadata.codexThreadId);
    const hasClaudeSession = Boolean(metadata.claudeSessionId);
    if (!hasCodexThread && !hasClaudeSession) {
        throw invalidContext(sessionId, 'the session has no Codex thread ID or Claude session ID');
    }
    if (metadata.flavor === 'codex' && !hasCodexThread) {
        throw invalidContext(sessionId, 'the Codex session has no thread ID');
    }
    if (metadata.flavor === 'claude' && !hasClaudeSession) {
        throw invalidContext(sessionId, 'the Claude session has no session ID');
    }

    // Process identity from an old server snapshot must not become adoptable
    // merely because this recovery writes the record with a fresh savedAt.
    const sanitizedMetadata: Metadata = { ...metadata } as Metadata;
    delete sanitizedMetadata.hostPid;
    delete sanitizedMetadata.hostProcessStartToken;

    return {
        encryptionKey: contextResult.data.encryptionKey,
        encryptionVariant: contextResult.data.encryptionVariant,
        seq: serverSession.seq,
        metadataVersion: RECONNECT_FORCE_HYDRATION_VERSION,
        agentStateVersion: RECONNECT_FORCE_HYDRATION_VERSION,
        metadata: sanitizedMetadata,
        savedAt,
    };
}
