/**
 * Agy stream-json parser
 *
 * `agy --output-format stream-json --print <prompt>` emits newline-delimited JSON
 * (NDJSON) records on stdout during a turn:
 *   - `init`: announces `conversation_id`, `model`, `cwd`, `tools`, `permission_mode`
 *   - `step_update`: incremental reasoning, `agent_response` deltas, and `tool`
 *     (`ACTIVE` → `DONE` / `ERROR`) lifecycle updates
 *   - `result`: terminal turn status (`SUCCESS` | `ERROR` | `CANCELED`), aggregate
 *     `response`, optional `error`, and token `usage`
 *
 * Isolating all `stream-json` framing and deduplication in this module keeps `AgyBackend` small and avoids touching shared
 * Happy wire/app schemas.
 */

import type { AgentMessage } from '@/agent/core/AgentBackend';

import { containsCredentialCarrier, isPlainRecord, truncateUtf8, mapAgyToolToDisplay, sanitizeDiagnosticText } from './toolDisplay';

export const MAX_STREAM_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_TURN = 512;
const MAX_AGENT_RESPONSE_STEPS = 512;
const MAX_STEP_INDEX = 1_000_000;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const VISIBLE_OUTPUT_TOOLS = new Set(['call_mcp_tool', 'command_status', 'manage_task', 'run_command', 'search_web']);

function safeToolOutput(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (containsCredentialCarrier(value)) return '[redacted output]';
  const truncated = truncateUtf8(value, MAX_TOOL_OUTPUT_BYTES);
  return containsCredentialCarrier(truncated) ? '[redacted output]' : truncated;
}

function safeStepIndex(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_STEP_INDEX
    ? value
    : undefined;
}

function safeConversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /\s/.test(trimmed)) return null;
  return trimmed;
}

export interface AgyStreamTurnParserOptions {
  turnNumber: number;
  emit: (msg: AgentMessage) => void;
  log?: (msg: string) => void;
}

export class AgyStreamTurnParser {
  private readonly turnNumber: number;
  private readonly emit: (msg: AgentMessage) => void;
  private readonly log: (msg: string) => void;

  private streamBuffer = '';
  private discardingOversizedRecord = false;
  private resultSeen = false;
  private pinnedConversationId: string | null = null;
  private failureDetail: string | null = null;

  private readonly startedToolCalls = new Set<string>();
  private readonly endedToolCalls = new Set<string>();
  private readonly toolDisplayNames = new Map<string, string>();
  private readonly agentResponseBuffers = new Map<number, string>();
  private readonly emittedSteps: string[] = [];
  private agentResponseBytes = 0;

  constructor(opts: AgyStreamTurnParserOptions) {
    this.turnNumber = opts.turnNumber;
    this.emit = opts.emit;
    this.log = opts.log ?? (() => {});
  }

  get conversationId(): string | null {
    return this.pinnedConversationId;
  }

  get streamFailure(): string | null {
    return this.failureDetail;
  }

  feed(chunk: string): void {
    let remaining = chunk;
    while (remaining) {
      if (this.discardingOversizedRecord) {
        const newline = remaining.indexOf('\n');
        if (newline === -1) return;
        this.discardingOversizedRecord = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      const newline = remaining.indexOf('\n');
      if (newline === -1) {
        const combinedBytes = Buffer.byteLength(this.streamBuffer, 'utf8')
          + Buffer.byteLength(remaining, 'utf8');
        if (combinedBytes > MAX_STREAM_RECORD_BYTES) {
          this.log(`ignored oversized agy stream-json record (>${MAX_STREAM_RECORD_BYTES} bytes)`);
          this.streamBuffer = '';
          this.discardingOversizedRecord = true;
        } else {
          this.streamBuffer += remaining;
        }
        return;
      }

      const prefix = remaining.slice(0, newline);
      const recordBytes = Buffer.byteLength(this.streamBuffer, 'utf8')
        + Buffer.byteLength(prefix, 'utf8');
      if (recordBytes > MAX_STREAM_RECORD_BYTES) {
        this.log(`ignored oversized agy stream-json record (${recordBytes} bytes)`);
      } else {
        const record = (this.streamBuffer + prefix).replace(/\r$/, '');
        if (record.trim()) {
          this.handleRecord(record);
        }
      }
      this.streamBuffer = '';
      remaining = remaining.slice(newline + 1);
    }
  }

  finish(options?: { failed?: boolean }): void {
    const trailing = this.streamBuffer.replace(/\r$/, '');
    this.streamBuffer = '';
    if (trailing.trim()) {
      let parsedTrailing: unknown;
      let isCompleteEventObject = false;
      if (trailing.trimStart().startsWith('{')) {
        try {
          parsedTrailing = JSON.parse(trailing);
          isCompleteEventObject = isPlainRecord(parsedTrailing)
            && typeof parsedTrailing.event === 'string';
        } catch {
          isCompleteEventObject = false;
        }
      }
      if (isCompleteEventObject && isPlainRecord(parsedTrailing)) {
        this.processParsedRecord(parsedTrailing);
      } else {
        this.log(`ignored unterminated agy stream-json record (${Buffer.byteLength(trailing, 'utf8')} bytes)`);
      }
    }

    if (!this.resultSeen) {
      this.flushAllAgentResponses();
    }

    const hasUnfinishedTools = [...this.startedToolCalls].some(callId => !this.endedToolCalls.has(callId));
    if (!this.resultSeen && hasUnfinishedTools) {
      this.failureDetail ??= 'agy stream ended before tool completion';
    }
    const isError = Boolean(options?.failed || this.failureDetail || !this.resultSeen);
    for (const callId of this.startedToolCalls) {
      if (this.endedToolCalls.has(callId)) continue;
      this.endedToolCalls.add(callId);
      const resolvedDisplayName = this.toolDisplayNames.get(callId) ?? 'agy_tool';
      this.emit({
        type: 'tool-result',
        toolName: resolvedDisplayName,
        callId,
        result: { status: isError ? 'ERROR' : 'DONE' },
        isError,
      });
    }
  }

  private captureConversationId(candidate: unknown): void {
    if (this.pinnedConversationId !== null) return;
    const cid = safeConversationId(candidate);
    if (cid) {
      this.pinnedConversationId = cid;
    }
  }

  private emitAgentResponse(stepIndex: number): void {
    const text = this.agentResponseBuffers.get(stepIndex);
    this.agentResponseBuffers.delete(stepIndex);
    if (!text) return;
    this.emittedSteps.push(text);
    this.emit({ type: 'model-output', textDelta: text });
  }

  private flushAgentResponsesBefore(stepIndex: number): void {
    const pending = [...this.agentResponseBuffers.keys()]
      .filter((idx) => idx < stepIndex)
      .sort((a, b) => a - b);
    for (const idx of pending) {
      this.emitAgentResponse(idx);
    }
  }

  private flushAllAgentResponses(): void {
    const pending = [...this.agentResponseBuffers.keys()].sort((a, b) => a - b);
    for (const idx of pending) {
      this.emitAgentResponse(idx);
    }
  }

  private handleRecord(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      this.log(`ignored malformed agy stream-json record (${Buffer.byteLength(line, 'utf8')} bytes)`);
      return;
    }
    if (!isPlainRecord(record)) {
      this.log(`ignored non-object agy stream-json record (${Buffer.byteLength(line, 'utf8')} bytes)`);
      return;
    }
    this.processParsedRecord(record);
  }

  private processParsedRecord(record: Record<string, unknown>): void {
    if (record.event === 'init') {
      this.captureConversationId(record.conversation_id);
      return;
    }

    if (record.event === 'result') {
      if (this.resultSeen) return;
      this.resultSeen = true;
      this.flushAllAgentResponses();

      const result = isPlainRecord(record.result) ? record.result : {};
      this.captureConversationId(result.conversation_id ?? record.conversation_id);

      if (isPlainRecord(result.usage)) {
        this.emit({ type: 'token-count', ...result.usage });
      }

      if (result.status !== 'SUCCESS') {
        const errorMsg = typeof result.error === 'string'
          ? sanitizeDiagnosticText(result.error)
          : '';
        this.failureDetail = errorMsg
          ? `agy stream reported failure: ${errorMsg}`
          : 'agy stream reported failure';
        return;
      }

      if (typeof result.response === 'string' && result.response.length > 0) {
        const remainder = this.unstreamedResultRemainder(result.response);
        if (remainder) {
          this.emittedSteps.push(remainder);
          this.emit({ type: 'model-output', textDelta: remainder });
        }
      }
      return;
    }

    if (record.event !== 'step_update' || !isPlainRecord(record.step_update)) {
      return;
    }

    const update = record.step_update;
    this.captureConversationId(update.conversation_id);

    const stepType = update.step_type;
    if (stepType === 'reasoning' || stepType === 'process' || stepType === 'thought') {
      if (typeof update.text_delta === 'string' && update.text_delta.length > 0) {
        this.emit({
          type: 'event',
          name: 'thinking',
          payload: { text: update.text_delta, streaming: true },
        });
      }
      return;
    }

    if (stepType === 'agent_response') {
      const stepIndex = safeStepIndex(update.step_index);
      if (stepIndex === undefined) return;
      if (typeof update.text_delta === 'string' && update.text_delta.length > 0) {
        if (
          !this.agentResponseBuffers.has(stepIndex)
          && this.agentResponseBuffers.size >= MAX_AGENT_RESPONSE_STEPS
        ) {
          return;
        }
        const deltaBytes = Buffer.byteLength(update.text_delta, 'utf8');
        if (this.agentResponseBytes + deltaBytes > MAX_STREAM_RECORD_BYTES) {
          return;
        }
        const current = this.agentResponseBuffers.get(stepIndex) ?? '';
        this.agentResponseBuffers.set(stepIndex, current + update.text_delta);
        this.agentResponseBytes += deltaBytes;
      }
      if (update.state === 'DONE' || update.state === 'ERROR') {
        this.emitAgentResponse(stepIndex);
      }
      return;
    }

    if (stepType === 'tool' || stepType === 'subagent') {
      const stepIndex = safeStepIndex(update.step_index);
      if (stepIndex === undefined) return;

      const toolInfo = isPlainRecord(update.tool_info) ? update.tool_info : {};
      const rawToolName = typeof update.tool_name === 'string' && update.tool_name
        ? update.tool_name
        : typeof toolInfo.name === 'string' && toolInfo.name
          ? toolInfo.name
          : stepType === 'subagent'
            ? 'invoke_subagent'
            : null;
      if (!rawToolName) return;

      // Ensure any preceding progress message is emitted before the tool card starts.
      this.flushAgentResponsesBefore(stepIndex);

      const callId = `agy:${this.turnNumber}:${stepIndex}`;
      const display = mapAgyToolToDisplay(rawToolName, toolInfo.parameters);

      if (update.state === 'ACTIVE') {
        if (this.startedToolCalls.has(callId) || this.startedToolCalls.size >= MAX_TOOL_CALLS_PER_TURN) {
          return;
        }
        this.startedToolCalls.add(callId);
        this.toolDisplayNames.set(callId, display.toolName);
        this.emit({ type: 'tool-call', ...display, callId });
        return;
      }

      if (update.state !== 'DONE' && update.state !== 'ERROR') return;
      if (this.endedToolCalls.has(callId)) return;

      if (!this.startedToolCalls.has(callId)) {
        if (this.startedToolCalls.size >= MAX_TOOL_CALLS_PER_TURN) return;
        this.startedToolCalls.add(callId);
        this.toolDisplayNames.set(callId, display.toolName);
        this.emit({ type: 'tool-call', ...display, callId });
      }
      this.endedToolCalls.add(callId);

      const resolvedDisplayName = this.toolDisplayNames.get(callId) ?? display.toolName;
      const normalizedToolName = rawToolName.toLowerCase();
      const toolOutput = VISIBLE_OUTPUT_TOOLS.has(normalizedToolName)
        ? safeToolOutput(toolInfo.output)
        : undefined;
      const toolResult: Record<string, unknown> = { status: update.state };
      if (toolOutput) {
        toolResult[update.state === 'ERROR' ? 'stderr' : 'stdout'] = toolOutput;
      }

      this.emit({
        type: 'tool-result',
        toolName: resolvedDisplayName,
        callId,
        result: toolResult,
        ...(update.state === 'ERROR' ? { isError: true } : {}),
      });
    }
  }

  private unstreamedResultRemainder(response: string): string {
    if (this.emittedSteps.length === 0) {
      return response;
    }

    const streamedConcat = this.emittedSteps.join('');
    const lastStep = this.emittedSteps[this.emittedSteps.length - 1] ?? '';

    if (
      response === streamedConcat
      || response === lastStep
      || response.trim() === streamedConcat.trim()
      || response.trim() === lastStep.trim()
    ) {
      return '';
    }

    if (response.startsWith(streamedConcat)) {
      const suffix = response.slice(streamedConcat.length);
      return suffix.trim().length > 0 ? suffix : '';
    }

    return '';
  }
}
