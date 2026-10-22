import { logger } from "@/ui/logger";

export type PendingAttachment = { data: Uint8Array; mimeType: string; name: string };

interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean; // If true, this message must be processed alone
    /** Decoded image attachments owned by *this* message (per-message ownership). */
    attachments?: PendingAttachment[];
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Delivers one message per call, in FIFO order, so each user message keeps its
 * own turn boundary even when several pile up while an agent turn is running.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
    private onMessageHandler: ((message: string, mode: T) => void) | null = null;
    modeHasher: (mode: T) => string;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: ((message: string, mode: T) => void) | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Set a handler that will be called when a message arrives
     */
    setOnMessage(handler: ((message: string, mode: T) => void) | null): void {
        this.onMessageHandler = handler;
    }

    /**
     * Push a message to the queue with a mode and an optional list of
     * attachments that travel with this message.
     */
    push(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: false,
            attachments,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] push() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message immediately without batching delay.
     * Does not clear the queue or enforce isolation.
     */
    pushImmediate(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushImmediate() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: false
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for immediate message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushImmediate() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed in complete isolation.
     * Clears any pending messages and ensures this message is never batched with others.
     * Used for special commands that require dedicated processing.
     */
    pushIsolateAndClear(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolateAndClear() called with mode hash: ${modeHash} - clearing ${this.queue.length} pending messages`);

        // Clear any pending messages to ensure this message is processed in complete isolation
        this.queue = [];

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolateAndClear() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed alone without discarding
     * already-queued user prompts.
     */
    pushIsolated(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolated() called with mode hash: ${modeHash}`);

        this.queue.push({
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolated() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshift() called with mode hash: ${modeHash}`);

        this.queue.unshift({
            message,
            mode,
            modeHash,
            isolate: false
        });

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] unshift() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Reset the queue - clears all messages and resets to empty state
     */
    reset(): void {
        logger.debug(`[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`);
        this.queue = [];
        this.closed = false;

        // Clear waiter without calling it since we're not closing
        this.waiter = null;
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue2] close() called`);
        this.closed = true;

        // Notify any waiting caller
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(false);
        }
    }

    /**
     * Check if the queue is closed
     */
    isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the current queue size
     */
    size(): number {
        return this.queue.length;
    }

    /**
     * Wait for a message and return the next one in the queue.
     * Returns { message: string, mode: T } or null if aborted/closed
     */
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string, mode: T, isolate: boolean, hash: string, attachments?: PendingAttachment[] } | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch();
        }

        // If closed or already aborted, return null
        if (this.closed || abortSignal?.aborted) {
            return null;
        }

        // Wait for messages to arrive
        const hasMessages = await this.waitForMessages(abortSignal);

        if (!hasMessages) {
            return null;
        }

        return this.collectBatch();
    }

    /**
     * Take the next queued message. One queued message is one turn: messages
     * that pile up while a turn is running keep their own boundaries instead of
     * being joined into a single prompt, so every question gets its own answer.
     */
    private collectBatch(): { message: string, mode: T, hash: string, isolate: boolean, attachments?: PendingAttachment[] } | null {
        const item = this.queue.shift();
        if (!item) {
            return null;
        }

        logger.debug(`[MessageQueue2] Collected message with mode hash: ${item.modeHash}${item.isolate ? ' (isolated)' : ''}. Remaining: ${this.queue.length}`);

        return {
            message: item.message,
            mode: item.mode,
            hash: item.modeHash,
            isolate: item.isolate ?? false,
            attachments: item.attachments && item.attachments.length > 0 ? item.attachments : undefined,
        };
    }

    /**
     * Wait for messages to arrive
     */
    private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            let abortHandler: (() => void) | null = null;

            // Set up abort handler
            if (abortSignal) {
                abortHandler = () => {
                    logger.debug('[MessageQueue2] Wait aborted');
                    // Clear waiter if it's still set
                    if (this.waiter === waiterFunc) {
                        this.waiter = null;
                    }
                    resolve(false);
                };
                abortSignal.addEventListener('abort', abortHandler);
            }

            const waiterFunc = (hasMessages: boolean) => {
                // Clean up abort handler
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(hasMessages);
            };

            // Check again in case messages arrived or queue closed while setting up
            if (this.queue.length > 0) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(true);
                return;
            }

            if (this.closed || abortSignal?.aborted) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(false);
                return;
            }

            // Set the waiter
            this.waiter = waiterFunc;
            logger.debug('[MessageQueue2] Waiting for messages...');
        });
    }
}
