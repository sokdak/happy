import type { PendingAttachment } from '@/utils/MessageQueue2';
import type { CodexTurnTarget } from './codexAppServerClient';
import { isCodexClearText } from './codexClearCommand';
import { parseCodexGoalCommand } from './codexGoalStatus';
import { hashCodexEnhancedMode, type CodexEnhancedMode } from './codexPrompt';

export type CodexPendingMessage = {
    message: string;
    mode: CodexEnhancedMode;
    attachments?: PendingAttachment[];
};

type TurnWindow = {
    modeHash: string;
    closed: boolean;
    target: Promise<CodexTurnTarget | null>;
    started: (target: CodexTurnTarget | null) => void;
    tail: Promise<void>;
};

/** Serializes mid-turn input and settles it before the next turn can start. */
export class CodexTurnSteering {
    private active: TurnWindow | null = null;

    constructor(private options: {
        enqueue: (message: CodexPendingMessage) => void;
        hasQueuedMessages: () => boolean;
        steer: (message: CodexPendingMessage, target: CodexTurnTarget) => Promise<boolean>;
        onError: (error: unknown) => void;
    }) {}

    async runTurn<T>(mode: CodexEnhancedMode, send: (onTurnStarted: (target: CodexTurnTarget) => void) => Promise<T>): Promise<T> {
        const turn = this.beginTurn(mode);
        try {
            return await send(turn.onTurnStarted);
        } finally {
            await turn.finish();
        }
    }

    beginTurn(mode: CodexEnhancedMode): {
        onTurnStarted: (target: CodexTurnTarget) => void;
        finish: () => Promise<void>;
    } {
        let started!: TurnWindow['started'];
        const target = new Promise<CodexTurnTarget | null>(resolve => { started = resolve; });
        const window: TurnWindow = {
            modeHash: hashCodexEnhancedMode(mode), closed: false, target, started, tail: Promise.resolve(),
        };
        this.active = window;
        return {
            onTurnStarted: started,
            finish: async () => {
                window.closed = true;
                started(null);
                // Input arriving while an acknowledgement is still pending
                // joins this tail too, so it cannot overtake rejected input.
                let tail: Promise<void>;
                do {
                    tail = window.tail;
                    await tail;
                } while (tail !== window.tail);
                if (this.active === window) this.active = null;
            },
        };
    }

    submit(message: CodexPendingMessage): void {
        const window = this.active;
        if (!window) {
            this.options.enqueue(message);
            return;
        }
        window.tail = window.tail.then(async () => {
            // turn/steer cannot change turn-level settings. Commands and
            // messages behind an existing queued turn keep their ordering.
            if (!window.closed && !this.options.hasQueuedMessages()
                && hashCodexEnhancedMode(message.mode) === window.modeHash
                && !isCodexClearText(message.message) && !parseCodexGoalCommand(message.message)) {
                const target = await window.target;
                if (target && !window.closed) {
                    try {
                        if (await this.options.steer(message, target)) return;
                    } catch (error) {
                        this.options.onError(error);
                    }
                }
            }
            this.options.enqueue(message);
        });
    }
}
