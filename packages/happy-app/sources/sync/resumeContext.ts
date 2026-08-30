import { encodeBase64 } from '@/encryption/base64';
import type { Session } from './storageTypes';

export type SessionResumeContext = {
    encryptionKey: string;
    encryptionVariant: 'dataKey';
};

type ResumeContextSession = Pick<Session, 'metadata'>;

/**
 * Build the server-backed context needed to resume a session that is no
 * longer present in the daemon's local retention window.
 *
 * Legacy sessions encrypted directly with the account key are deliberately
 * unsupported: only an explicit per-session data key may leave the app.
 */
export function buildSessionResumeContext(
    session: ResumeContextSession,
    dataKey: Uint8Array | null | undefined,
): SessionResumeContext | undefined {
    const metadata = session.metadata;
    if (!dataKey || dataKey.length !== 32 || !metadata) {
        return undefined;
    }

    const hasMachineId = typeof metadata.machineId === 'string' && metadata.machineId.trim().length > 0;
    const hasPath = typeof metadata.path === 'string' && metadata.path.trim().length > 0;
    const hasClaudeSessionId = typeof metadata.claudeSessionId === 'string' && metadata.claudeSessionId.trim().length > 0;
    const hasCodexThreadId = typeof metadata.codexThreadId === 'string' && metadata.codexThreadId.trim().length > 0;
    if (!hasMachineId || !hasPath || (!hasClaudeSessionId && !hasCodexThreadId)) {
        return undefined;
    }
    if (metadata.flavor === 'claude' && !hasClaudeSessionId) {
        return undefined;
    }
    if (metadata.flavor === 'codex' && !hasCodexThreadId) {
        return undefined;
    }

    return {
        encryptionKey: encodeBase64(dataKey, 'base64'),
        encryptionVariant: 'dataKey',
    };
}
