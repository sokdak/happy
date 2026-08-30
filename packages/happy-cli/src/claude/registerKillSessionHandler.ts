import { ApiSessionClient } from "@/api/apiSession";
import { logger } from "@/lib";

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}


/**
 * Registers every way this session ends on its own terms.
 *
 * Both paths run the same `killThisHappy`, which is each agent's graceful
 * shutdown: abort the turn, archive the session, tell the server it died, then
 * exit. That matters for the idle path too - a session reaped without it would
 * leave the server believing it is still active.
 */
export function registerKillSessionHandler(
    session: ApiSessionClient,
    killThisHappy: () => Promise<void>
) {
    session.armIdleWatchdog(() => {
        logger.debug('Session idle timeout reached - terminating');
        void killThisHappy();
    });

    session.rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>('killSession', async () => {
        logger.debug('Kill session request received');

        // This will start the cleanup process
        void killThisHappy();

        // We should still be able to respond the the client, though they
        // should optimistically assume the session is dead.
        return {
            success: true,
            message: 'Killing happy-cli process'
        };
    });
}
