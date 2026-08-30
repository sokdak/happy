export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: Array<{
        resolve: () => void;
        reject: (reason?: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
    }> = [];

    async inLock<T>(func: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
        await this.lock(signal);
        try {
            if (signal?.aborted) {
                throw signal.reason ?? new Error('Lock acquisition aborted');
            }
            return await func();
        } finally {
            this.unlock();
        }
    }

    private async lock(signal?: AbortSignal) {
        if (signal?.aborted) {
            throw signal.reason ?? new Error('Lock acquisition aborted');
        }
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: (typeof this.promiseResolverQueue)[number] = { resolve, reject, signal };
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.promiseResolverQueue.indexOf(waiter);
                    if (index >= 0) {
                        this.promiseResolverQueue.splice(index, 1);
                        reject(signal.reason ?? new Error('Lock acquisition aborted'));
                    }
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.promiseResolverQueue.push(waiter);
        });
    }

    private unlock() {
        this.permits += 1;
        if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
            throw new Error('this.permits should never be > 0 when there is someone waiting.');
        } else if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
            // If there is someone else waiting, immediately consume the permit that was released
            // at the beginning of this function and let the waiting function resume.
            this.permits -= 1;

            const next = this.promiseResolverQueue.shift();
            // Resolve on the next tick
            if (next) {
                if (next.signal && next.onAbort) {
                    next.signal.removeEventListener('abort', next.onAbort);
                }
                setTimeout(() => {
                    next.resolve();
                }, 0);
            }
        }
    }
}
