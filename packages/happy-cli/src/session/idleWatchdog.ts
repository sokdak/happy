/**
 * Reaping sessions nobody is using any more.
 *
 * A session process keeps its agent wrapper and app-server alive for as long as
 * it runs, and nothing ever ended one: the only termination paths are an
 * explicit stop from the app and the process dying. A host running the daemon
 * for weeks accumulated wrapper processes for sessions that had been connected
 * once and never used again (sokdak/happy-helm#22).
 *
 * The judgement lives in the session process rather than the daemon, because
 * this is the only place that knows whether a turn is running - and because a
 * clock kept here is not reset by a daemon restart.
 *
 * "Idle" means no turn has been observed for the timeout. A turn that runs for
 * two days is working, not idle, so the clock only advances while the session
 * is quiet.
 */

const DEFAULT_IDLE_TIMEOUT_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export function resolveIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.HAPPY_SESSION_IDLE_TIMEOUT_HOURS;
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_IDLE_TIMEOUT_HOURS * HOUR_MS;
    }

    const hours = Number(raw);
    // Terminating sessions is not the place to act on a value we cannot read.
    if (!Number.isFinite(hours) || hours < 0) {
        return DEFAULT_IDLE_TIMEOUT_HOURS * HOUR_MS;
    }

    return Math.round(hours * HOUR_MS);
}

export interface IdleWatchdog {
    /**
     * Report the session's current state. Called from the keep-alive tick that
     * every agent already runs, so `busy` is the same `thinking` flag the
     * server is told about.
     */
    observe(busy: boolean): void;
    idleMs(): number;
    stop(): void;
}

export function createIdleWatchdog(opts: {
    timeoutMs: number;
    onIdle: () => void;
    now?: () => number;
}): IdleWatchdog {
    const now = opts.now ?? Date.now;
    let lastBusyAt = now();
    let fired = false;
    let stopped = false;

    return {
        observe(busy: boolean) {
            if (stopped) {
                return;
            }
            if (busy) {
                lastBusyAt = now();
                return;
            }
            if (opts.timeoutMs <= 0 || fired) {
                return;
            }
            if (now() - lastBusyAt >= opts.timeoutMs) {
                fired = true;
                opts.onIdle();
            }
        },
        idleMs() {
            return now() - lastBusyAt;
        },
        stop() {
            stopped = true;
        },
    };
}
