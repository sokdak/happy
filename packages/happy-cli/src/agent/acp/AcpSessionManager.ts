import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

const MAX_SESSION_CALL_IDS = 4_096;

export class AcpSessionManager {
  private currentTurnId: string | null = null;
  private lastTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;

  constructor(private readonly options: {
    preserveTextWhitespace?: boolean;
    forwardToolResults?: boolean;
    allowPostTurnFollowups?: boolean;
  } = {}) {}

  private effectiveTurnId(): string | null {
    return this.currentTurnId ?? (this.options.allowPostTurnFollowups ? this.lastTurnId : null);
  }

  resetSessionCallIds(): void {
    this.acpCallToSessionCall.clear();
    this.lastTurnId = this.currentTurnId;
  }

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  /**
   * Resolve the stable Happy CUID2 tool-call identifier for an ACP toolCallId so
   * out-of-band permission requests and in-band tool-call envelopes join onto one card.
   */
  resolveSessionCallId(acpCallId: string): string {
    return this.ensureSessionCallId(acpCallId);
  }

  private ensureSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    if (this.options.allowPostTurnFollowups && this.acpCallToSessionCall.size >= MAX_SESSION_CALL_IDS) {
      const oldest = this.acpCallToSessionCall.keys().next().value;
      if (oldest !== undefined) {
        this.acpCallToSessionCall.delete(oldest);
      }
    }
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  private flush(): SessionEnvelope[] {
    if (!this.pendingText || !this.pendingType) {
      return [];
    }
    const text = this.options.preserveTextWhitespace
      ? this.pendingText
      : this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;

    if (!text) {
      return [];
    }
    const turnId = this.effectiveTurnId();
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(turnId, this.nextTime()))];
    }
    return [createEnvelope('agent', { t: 'text', text }, turnOptions(turnId, this.nextTime()))];
  }

  /** Opt-in bounded-latency delivery for runners that receive continuous ACP deltas. */
  flushPendingText(): SessionEnvelope[] {
    return this.flush();
  }

  getTurnId(): string | null { return this.currentTurnId; }

  getEffectiveTurnId(): string | null { return this.effectiveTurnId(); }

  nextEnvelopeTime(): number { return this.nextTime(); }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    const flushed = this.options.allowPostTurnFollowups ? this.flush() : [];
    this.currentTurnId = createId();
    this.lastTurnId = this.currentTurnId;
    if (!this.options.allowPostTurnFollowups) {
      this.acpCallToSessionCall.clear();
    }
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    if (!this.options.allowPostTurnFollowups) {
      this.acpCallToSessionCall.clear();
    }
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'agy_step_complete') {
      return this.flush();
    }

    if (msg.type === 'event' && msg.name === 'thinking') {
      const { text, streaming } = parseThinkingPayload(msg.payload);
      if (!text) {
        return [];
      }

      if (streaming) {
        // Streaming thinking: accumulate, flush if switching from a different type
        const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
        this.pendingType = 'thinking';
        this.pendingText += text;
        return flushed;
      }

      // Non-streaming thinking: flush pending, emit immediately
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return this.flush();
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.effectiveTurnId(), this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      const turnId = this.effectiveTurnId();
      if (msg.status === 'error' && turnId) {
        const detail = msg.detail?.trim() || 'The agent stopped because of an unknown error.';
        return [
          ...this.flush(),
          createEnvelope(
            'agent',
            { t: 'service', text: `Error: ${detail}` },
            { turn: turnId, time: this.nextTime() },
          ),
        ];
      }
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Accumulate output, flush if switching from a different type
      const flushed = this.pendingType !== 'output' ? this.flush() : [];
      this.pendingType = 'output';
      this.pendingText += text;
      return flushed;
    }

    if (msg.type === 'tool-call') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: msg.toolName,
          title: buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.effectiveTurnId(), this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-end', call,
          ...(this.options.forwardToolResults && typeof msg.result === 'string' ? { result: msg.result } : {}),
          ...(this.options.forwardToolResults && msg.isError !== undefined ? { isError: msg.isError } : {}),
        }, turnOptions(this.effectiveTurnId(), this.nextTime())),
      ];
    }

    return [];
  }
}
