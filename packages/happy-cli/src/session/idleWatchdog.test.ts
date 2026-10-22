import { describe, expect, it, vi } from 'vitest';
import { createIdleWatchdog, resolveIdleTimeoutMs } from './idleWatchdog';

const HOUR = 60 * 60 * 1000;

describe('resolveIdleTimeoutMs', () => {
    it('defaults to a day', () => {
        expect(resolveIdleTimeoutMs({})).toBe(24 * HOUR);
    });

    it('takes an explicit number of hours', () => {
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: '2' })).toBe(2 * HOUR);
    });

    it('treats 0 as "never reap"', () => {
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: '0' })).toBe(0);
    });

    it('accepts fractions of an hour', () => {
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: '0.5' })).toBe(30 * 60 * 1000);
    });

    it('falls back to the default rather than acting on a value it cannot read', () => {
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: 'never' })).toBe(24 * HOUR);
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: '-3' })).toBe(24 * HOUR);
        expect(resolveIdleTimeoutMs({ HAPPY_SESSION_IDLE_TIMEOUT_HOURS: '  ' })).toBe(24 * HOUR);
    });
});

describe('createIdleWatchdog', () => {
    const setup = (timeoutMs: number) => {
        let now = 1_000_000;
        const onIdle = vi.fn();
        const watchdog = createIdleWatchdog({ timeoutMs, onIdle, now: () => now });
        return { watchdog, onIdle, advance: (ms: number) => { now += ms; } };
    };

    it('does nothing before the timeout elapses', () => {
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(false);
        advance(HOUR - 1);
        watchdog.observe(false);

        expect(onIdle).not.toHaveBeenCalled();
    });

    it('fires once the session has been quiet for the timeout', () => {
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(false);
        advance(HOUR);
        watchdog.observe(false);

        expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('never fires while a turn is running, however long it runs', () => {
        // A turn that thinks for two days is working, not idle.
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(true);
        advance(48 * HOUR);
        watchdog.observe(true);

        expect(onIdle).not.toHaveBeenCalled();
    });

    it('restarts the clock when a turn ends', () => {
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(false);
        advance(HOUR - 1);
        watchdog.observe(true);
        advance(HOUR - 1);
        watchdog.observe(false);

        expect(onIdle).not.toHaveBeenCalled();

        advance(HOUR);
        watchdog.observe(false);
        expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('fires only once even if it keeps being asked', () => {
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(false);
        advance(10 * HOUR);
        watchdog.observe(false);
        watchdog.observe(false);
        watchdog.observe(false);

        expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all when the timeout is disabled', () => {
        const { watchdog, onIdle, advance } = setup(0);

        watchdog.observe(false);
        advance(1000 * HOUR);
        watchdog.observe(false);

        expect(onIdle).not.toHaveBeenCalled();
    });

    it('stops reporting once stopped', () => {
        const { watchdog, onIdle, advance } = setup(HOUR);

        watchdog.observe(false);
        watchdog.stop();
        advance(10 * HOUR);
        watchdog.observe(false);

        expect(onIdle).not.toHaveBeenCalled();
    });

    it('reports how long it has been idle', () => {
        const { watchdog, advance } = setup(HOUR);

        watchdog.observe(false);
        advance(90 * 60 * 1000);

        expect(watchdog.idleMs()).toBe(90 * 60 * 1000);
    });
});
