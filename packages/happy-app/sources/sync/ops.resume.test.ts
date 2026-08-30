import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResumeContext } from './resumeContext';

const { machineRPC } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));

describe('machineResumeSession', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    });

    it('keeps the legacy RPC payload unchanged when context is unavailable', async () => {
        const { machineResumeSession } = await import('./ops');

        await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'session-1',
            model: 'model-1',
            permissionMode: 'default',
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                sessionId: 'session-1',
                model: 'model-1',
                permissionMode: 'default',
            },
        );
    });

    it('adds the optional resume context to the existing RPC payload', async () => {
        const { machineResumeSession } = await import('./ops');
        const resumeContext: SessionResumeContext = {
            encryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            encryptionVariant: 'dataKey',
        };

        await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'session-1',
            resumeContext,
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                sessionId: 'session-1',
                model: undefined,
                permissionMode: undefined,
                resumeContext,
            },
        );
    });
});
