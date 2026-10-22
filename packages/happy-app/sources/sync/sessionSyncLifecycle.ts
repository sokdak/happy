type Stoppable = { stop: () => void };
type Abortable = { abort: () => void };

export function resolveExistingViewingSessionId(state: {
    currentViewingSessionId: string | null;
    sessions: Record<string, unknown>;
}): string | null {
    const sessionId = state.currentViewingSessionId;
    return sessionId && state.sessions[sessionId] ? sessionId : null;
}

/** Stop asynchronous work before its session and encryption state disappear. */
export function stopDeletedSessionWork<
    TMessageSync extends Stoppable,
    TSendSync extends Stoppable,
    TController extends Abortable,
    TOutbox,
>(
    sessionId: string,
    registries: {
        messagesSync: Map<string, TMessageSync>;
        sendSync: Map<string, TSendSync>;
        sendAbortControllers: Map<string, TController>;
        pendingOutbox: Map<string, TOutbox>;
    },
): void {
    registries.messagesSync.get(sessionId)?.stop();
    registries.messagesSync.delete(sessionId);
    registries.sendSync.get(sessionId)?.stop();
    registries.sendSync.delete(sessionId);

    const sendController = registries.sendAbortControllers.get(sessionId);
    registries.sendAbortControllers.delete(sessionId);
    registries.pendingOutbox.delete(sessionId);
    sendController?.abort();
}
