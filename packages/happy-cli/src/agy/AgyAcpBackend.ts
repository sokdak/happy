/** Persistent Antigravity ACP adapter, isolated from the generic ACP backend. */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream,
  type McpServer, type ContentBlock, type NewSessionResponse, type SessionNotification,
  type RequestPermissionRequest, type RequestPermissionResponse, type ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { Metadata, PermissionMode } from '@/api/types';
import { AGY_EFFORT_LEVELS, groupAgyModels, selectAgyEffort } from '@slopus/happy-wire';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { resolveAgyBin, resolveAgyModelName } from './constants';
import {
  containsCredentialCarrier,
  hasQuestionCredentialCarrier,
  isPlainRecord,
  mapAgyToolToDisplay,
  parseAgyAskQuestionInput,
  sanitizeDiagnosticText,
  sanitizeDiffText,
  type AgyParsedQuestion,
} from './toolDisplay';
import {
  AgyStopHook,
  resolveAgyStopHookSetting,
  STOP_HOOK_LIMITS,
  type StopHookLimits,
  type StopHookOption,
  type StopHookSetting,
} from './stopHook';

// AGY 1.5.9 omits rawInput.name on native calls. Only its exact "Run <id>"
// labels for known native tools may override a broad ACP category such as other.
// Arbitrary human titles (which can contain commands or private text) stay out.
const NATIVE_TOOL_LABELS = new Set([
  'list_dir', 'list_directory', 'read_file', 'view_file', 'sed_file',
  'edit_file', 'replace_file_content', 'multi_replace_file_content',
  'write_file', 'write_to_file', 'notebook_edit', 'run_command',
  'command_status', 'send_command_input', 'manage_task', 'schedule',
  'call_mcp_tool', 'list_resources', 'read_resource', 'search_web',
  'grep_search', 'find_by_name', 'open_browser_url', 'read_url_content',
  'invoke_subagent', 'manage_subagents', 'swarm', 'run_workflow',
  'ask_question', 'send_message', 'define_subagent',
]);

// Action/mutation/delegation tools that advance work between background waits.
// Status/wait/inspection tools (manage_task, command_status, manage_subagents,
// schedule, read_file, etc.) must not reset the stalled continuation budget.
const PROGRESS_NATIVE_TOOLS = new Set([
  'run_command', 'send_command_input',
  'edit_file', 'replace_file_content', 'multi_replace_file_content',
  'write_file', 'write_to_file', 'notebook_edit',
  'invoke_subagent', 'send_message', 'define_subagent',
  'swarm', 'run_workflow',
]);

const MAX_COMPLETED_TOOLS = 4_096;

// Share one version policy for the observer and native post-turn ACP events.
// Recheck the lifecycle contract when AGY changes its release line.
function getAgyLifecycleSupport(version: string | undefined): 'native' | 'legacy' | 'observer' | 'unsupported' {
  const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version ?? '');
  if (!release) return 'unsupported';
  const [major, minor, patch] = release.slice(1).map(Number);
  if (major > 1 || (major === 1 && minor > 5)) return 'unsupported';
  if (major < 1 || minor < 5 || patch < 9) return 'native';
  return patch === 9 ? 'legacy' : 'observer';
}

class AgyStopHookCompatibilityError extends Error {}

export class AgyCancelledError extends Error {
  constructor() { super('Antigravity turn cancelled'); this.name = 'AgyCancelledError'; }
}

export interface AgyAcpOptions {
  cwd: string;
  permissionMode: PermissionMode;
  mcpServers?: McpServer[];
  initialPrompt?: string;
  model?: string;
  effort?: string;
  /** Explicit ACP session ID only; never consult the workspace conversation cache. */
  resumeSessionId?: string;
  log?: (message: string) => void;
  requestPermission?: (id: string, tool: string, input: unknown) => Promise<{
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  }>;
  resetPermissions?: () => void;
  /**
   * Optional interactive question bridge (wired by runAgy to AgentUserInputHandler).
   * When set and a single valid `ask_question` call pauses for user input,
   * AgyAcpBackend delegates its card lifecycle to this callback instead of emitting
   * a generic Bash tool-call/tool-result pair.
   */
  onQuestion?: (callId: string, questions: AgyParsedQuestion[], signal: AbortSignal) => void;
  spawnFn?: typeof spawn;
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
  /**
   * Stop-hook mode:
   * - unset: reads HAPPY_AGY_STOP_HOOK (on Unix, defaults to observer mode for
   *   AGY >=1.5.10 <1.6.0 and legacy continue mode for AGY 1.5.9).
   * - true / '1': force the default hook selection for those versions.
   * - 'observe': observer-only mode (`{}` response, AGY >=1.5.10 <1.6.0).
   * - 'continue': explicit legacy forced continuation rollback.
   * - false / '0': disables all Stop hooks.
   */
  stopHook?: StopHookOption;
  stopHookLimits?: Partial<StopHookLimits>;
  permissionDenialSettleMs?: number;
  observerSettleMs?: number;
}

function mergeDefinedArgs(
  older: Record<string, unknown>,
  newer: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...older };
  for (const [key, nextVal] of Object.entries(newer)) {
    if (nextVal === undefined || nextVal === null) continue;
    const prevVal = merged[key];
    if (nextVal === '' && typeof prevVal === 'string' && prevVal.length > 0) continue;
    merged[key] = nextVal;
  }
  return merged;
}

function argsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in b) || JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

export class AgyAcpBackend implements AgentBackend {
  private handlers = new Set<AgentMessageHandler>();
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null;
  private metadata: Omit<NewSessionResponse, 'sessionId'> = {};
  private capabilities: { loadSession?: boolean; promptCapabilities?: { image?: boolean } } = {};
  private starting: Promise<void> | null = null;
  private active: Promise<void> | null = null;
  private cancelling: Promise<void> | null = null;
  private lifetime: Promise<never> = new Promise(() => {});
  private rejectLifetime?: (error: Error) => void;
  private cancelled = false;
  private disposed = false;
  private replaying = false;
  private supportsPostTurnFollowups = false;
  private promptRunning = false;
  private sessionAcceptingEvents = false;
  private pausedQuestionSession = false;
  private backgroundRunning = false;
  private backgroundStepDirty = false;
  private workEpoch = 0;
  private pendingPermissions = 0;
  private foregroundPermissions = new Map<number, number>();
  private drainingCancelTools: (() => void) | null = null;
  private observerWake: (() => void) | null = null;
  private questionActivitySeq = 0;
  private postTurnQuestionTimer: ReturnType<typeof setTimeout> | null = null;
  private taintedStreamLatch = false;
  private taintedOutputRedacted = false;
  private taintedThoughtRedacted = false;
  private taintedOutputBuffer = '';
  private taintedThoughtBuffer = '';
  private tools = new Map<string, {
    toolName: string;
    nativeName: string;
    args: Record<string, unknown>;
    rawParameters?: Record<string, unknown>;
    parsedQuestions?: AgyParsedQuestion[];
    commandExecution: boolean;
    isDaemon: boolean;
    isQuestion: boolean;
    payloadSeen: boolean;
    startedIncomplete: boolean;
    taintedQuestion: boolean;
    questionPending: boolean;
    pendingEpoch: number | null;
    pendingAtObservations: number;
    deferredEmit: boolean;
    delegatedQuestion: boolean;
    questionAbort?: AbortController;
    ownerEpoch: number;
  }>();
  private completedTools = new Set<string>();
  private terminating = new Set<Promise<void>>();
  private permissionAbort = new AbortController();
  private mode: PermissionMode;
  private model?: string;
  private effort?: string;
  private appliedModel: string | null = null;
  private appliedMode: string | null = null;
  private initialPromptDelivered = false;
  private stopHook: AgyStopHook | null = null;
  private permissionDenied = false;

  constructor(private readonly options: AgyAcpOptions) {
    this.sessionId = options.resumeSessionId ?? null;
    this.mode = options.permissionMode;
    this.model = options.model;
    this.effort = options.effort;
  }
  setPermissionMode(mode: PermissionMode): void { this.mode = mode; }
  setModel(model: string | undefined): void { this.model = model; }
  setEffort(effort: string | undefined): void { this.effort = effort; }
  onMessage(handler: AgentMessageHandler): void { this.handlers.add(handler); }
  offMessage(handler: AgentMessageHandler): void { this.handlers.delete(handler); }
  private emit(message: AgentMessage): void {
    if (this.disposed) return;
    for (const handler of this.handlers) handler(message);
  }

  /** Control requests have a deadline. Prompt completion never depends on an idle/print timer. */
  private async control<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Antigravity ACP control request timed out')), this.options.requestTimeoutMs ?? 30_000);
      })]);
    } catch (error) {
      // Ambiguous initialization/configuration results must not be reused.
      this.stopProcess();
      throw error;
    } finally { clearTimeout(timer); }
  }

  private trackCompletedTool(callId: string): void {
    this.completedTools.add(callId);
    if (this.completedTools.size > MAX_COMPLETED_TOOLS) {
      const oldest = this.completedTools.values().next().value;
      if (oldest !== undefined) this.completedTools.delete(oldest);
    }
  }

  private hasOpenActiveForegroundTools(epoch: number): boolean {
    for (const tool of this.tools.values()) {
      if (tool.ownerEpoch === epoch && !tool.isDaemon && !(tool.isQuestion && tool.questionPending)) return true;
    }
    return false;
  }

  private hasOpenForegroundPermissions(epoch: number): boolean {
    return (this.foregroundPermissions.get(epoch) ?? 0) > 0;
  }

  private hasAnyOpenActiveTools(): boolean {
    for (const tool of this.tools.values()) {
      if (!tool.isDaemon && (!tool.isQuestion || (tool.ownerEpoch === this.workEpoch && !tool.questionPending))) {
        return true;
      }
    }
    return false;
  }

  private hasQuestionPayload(raw: Record<string, unknown> | undefined): boolean {
    if (!raw) return false;
    const list = Array.isArray(raw.questions)
      ? raw.questions
      : isPlainRecord(raw.question)
        ? [raw.question]
        : typeof raw.question === 'string'
          ? [raw]
          : [];
    return list.length > 0 && list.every((item) =>
      isPlainRecord(item)
      && typeof item.question === 'string'
      && item.question.trim().length > 0
      && Array.isArray(item.options)
      && item.options.length > 0
      && item.options.every((opt) =>
        (typeof opt === 'string' && opt.trim().length > 0)
        || (isPlainRecord(opt) && typeof opt.label === 'string' && opt.label.trim().length > 0),
      ),
    );
  }

  private hasUnresolvedQuestionPayload(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen)) return true;
    }
    return false;
  }

  private shouldBufferQuestionStream(): boolean {
    if (this.taintedStreamLatch) return true;
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen || tool.startedIncomplete)) return true;
    }
    return false;
  }

  private hasAnyOpenNonDaemonTools(): boolean {
    for (const tool of this.tools.values()) {
      if (!tool.isDaemon) return true;
    }
    return false;
  }

  private hasOpenQuestionTools(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion) return true;
    }
    return false;
  }

  private hasTaintedQuestionTools(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && tool.taintedQuestion) return true;
    }
    return false;
  }

  private hasPendingQuestionTools(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && tool.questionPending) return true;
    }
    return false;
  }

  private hasPendingQuestionForEpoch(epoch: number, observations?: number): boolean {
    for (const tool of this.tools.values()) {
      if (
        tool.isQuestion
        && tool.questionPending
        && tool.pendingEpoch === epoch
        && (observations === undefined || tool.pendingAtObservations === observations)
      ) {
        return true;
      }
    }
    return false;
  }

  private hasDelegatedQuestion(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.delegatedQuestion) return true;
    }
    return false;
  }

  private hasUnpopulatedPendingQuestion(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && tool.questionPending && !tool.payloadSeen) return true;
    }
    return false;
  }

  private clearPostTurnQuestionTimer(): void {
    if (this.postTurnQuestionTimer) {
      clearTimeout(this.postTurnQuestionTimer);
      this.postTurnQuestionTimer = null;
    }
  }

  private flushTaintedBuffers(): void {
    const mustSanitize = this.taintedStreamLatch || this.hasUnresolvedQuestionPayload();
    if (this.taintedThoughtBuffer) {
      const rawThought = this.taintedThoughtBuffer;
      this.taintedThoughtBuffer = '';
      if (!mustSanitize) {
        this.emit({ type: 'event', name: 'thinking', payload: { text: rawThought, streaming: true } });
      } else if (!this.taintedThoughtRedacted) {
        this.taintedThoughtRedacted = true;
        this.emit({ type: 'event', name: 'thinking', payload: { text: '[redacted]', streaming: true } });
      }
    }
    if (this.taintedOutputBuffer) {
      const rawOutput = this.taintedOutputBuffer;
      this.taintedOutputBuffer = '';
      if (!mustSanitize) {
        this.emit({ type: 'model-output', textDelta: rawOutput });
      } else if (!this.taintedOutputRedacted) {
        this.taintedOutputRedacted = true;
        this.emit({ type: 'model-output', textDelta: '[redacted]' });
      }
    }
  }

  republishPausedQuestion(): boolean {
    if (!this.options.onQuestion || this.active || this.cancelling || this.disposed) return false;
    for (const [callId, tool] of this.tools) {
      if (tool.isQuestion && tool.questionPending && tool.delegatedQuestion && tool.parsedQuestions) {
        tool.questionAbort?.abort();
        const controller = new AbortController();
        tool.questionAbort = controller;
        this.options.onQuestion(`${callId}:retry:${++this.questionActivitySeq}`, tool.parsedQuestions, controller.signal);
        return true;
      }
    }
    return false;
  }

  private schedulePostTurnQuestionSettle(): void {
    this.clearPostTurnQuestionTimer();
    const delayMs = Math.max(80, (this.options.observerSettleMs ?? 25) * 4);
    this.postTurnQuestionTimer = setTimeout(() => {
      this.postTurnQuestionTimer = null;
      if (this.active || this.cancelling || this.disposed) return;
      const totalObs = this.stopHook?.policy.totalObservations();
      for (const tool of this.tools.values()) {
        if (tool.isQuestion && tool.questionPending && totalObs !== undefined && tool.pendingAtObservations < totalObs) {
          tool.questionPending = false;
          tool.pendingEpoch = null;
          tool.questionAbort?.abort();
        }
      }
      if (!this.hasPendingQuestionTools() || this.hasAnyOpenActiveTools() || this.pendingPermissions > 0) return;
      if (this.hasUnpopulatedPendingQuestion()) return;
      this.flushTaintedBuffers();
      this.settleDaemonTools();
      if (this.backgroundStepDirty) {
        this.backgroundStepDirty = false;
        this.emit({ type: 'event', name: 'agy_step_complete', payload: null });
      }
      this.promoteDeferredQuestionTools(undefined, totalObs);
      this.pausedQuestionSession = this.hasPendingQuestionTools();
      if (this.backgroundRunning) {
        this.backgroundRunning = false;
        this.emit({ type: 'status', status: 'idle' });
      }
    }, delayMs);
  }

  private reapStaleQuestions(epoch: number): void {
    for (const [callId, tool] of this.tools) {
      if (!tool.isQuestion) continue;
      const isCurrentPending = tool.questionPending && tool.pendingEpoch === epoch;
      if (isCurrentPending) continue;
      if (tool.ownerEpoch >= epoch && tool.questionPending) continue;
      if (tool.taintedQuestion || !tool.payloadSeen) {
        this.taintedStreamLatch = true;
      }
      tool.questionAbort?.abort();
      tool.rawParameters = undefined;
      if (!tool.delegatedQuestion) {
        if (tool.deferredEmit) {
          tool.deferredEmit = false;
          this.emit({ type: 'tool-call', callId, toolName: tool.toolName, args: tool.args });
        }
        this.emit({ type: 'tool-result', callId, toolName: tool.toolName, result: null, isError: false });
      }
      this.tools.delete(callId);
      this.trackCompletedTool(callId);
    }
    if (!this.shouldBufferQuestionStream()) {
      this.flushTaintedBuffers();
    }
  }

  private promoteDeferredQuestionTools(epoch?: number, observations?: number): void {
    if (epoch !== undefined) {
      for (const tool of this.tools.values()) {
        if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen)) {
          this.taintedStreamLatch = true;
        }
      }
      this.flushTaintedBuffers();
      this.reapStaleQuestions(epoch);
    } else if (!this.hasUnpopulatedPendingQuestion()) {
      this.flushTaintedBuffers();
    }
    const eligibleEntries: Array<[string, NonNullable<ReturnType<typeof this.tools.get>>]> = [];
    for (const [callId, tool] of this.tools) {
      if (
        tool.isQuestion
        && tool.deferredEmit
        && tool.questionPending
        && (epoch === undefined || tool.pendingEpoch === epoch)
        && (observations === undefined || tool.pendingAtObservations === observations)
      ) {
        eligibleEntries.push([callId, tool]);
      }
    }
    const canDelegateSingle = Boolean(this.options.onQuestion)
      && eligibleEntries.length === 1
      && !this.hasDelegatedQuestion();

    for (const [callId, tool] of this.tools) {
      if (!tool.isQuestion || !tool.deferredEmit) continue;
      if (epoch !== undefined && tool.pendingEpoch !== epoch) continue;
      if (observations !== undefined && tool.pendingAtObservations !== observations) continue;
      const rawParameters = tool.rawParameters;
      // On post-turn reactive streams, if `pending` arrived without question fields before a
      // follow-up `tool_call_update` carrying `rawInput.questions`, keep `deferredEmit`
      // armed so the subsequent update can promote it.
      if (epoch === undefined && !this.hasQuestionPayload(rawParameters)) {
        continue;
      }
      tool.deferredEmit = false;
      tool.rawParameters = undefined;
      if (canDelegateSingle && eligibleEntries[0]?.[0] === callId && !tool.delegatedQuestion) {
        const parsed = rawParameters ? parseAgyAskQuestionInput(rawParameters) : null;
        if (parsed) {
          const controller = new AbortController();
          tool.startedIncomplete = false;
          tool.delegatedQuestion = true;
          tool.parsedQuestions = parsed;
          tool.questionAbort = controller;
          this.options.onQuestion!(callId, parsed, controller.signal);
          continue;
        }
      }
      this.emit({ type: 'tool-call', callId, toolName: tool.toolName, args: tool.args });
    }
  }

  private settleDaemonTools(): void {
    for (const [callId, tool] of this.tools) {
      if (!tool.isDaemon) continue;
      this.emit({
        type: 'tool-result',
        callId,
        toolName: tool.toolName,
        result: 'Background daemon continues running.',
        isError: false,
      });
      this.tools.delete(callId);
      this.trackCompletedTool(callId);
    }
  }

  private closeUnresolvedTools(): void {
    for (const tool of this.tools.values()) {
      if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen)) {
        this.taintedStreamLatch = true;
      }
    }
    this.flushTaintedBuffers();
    for (const [callId, tool] of this.tools) {
      tool.questionAbort?.abort();
      tool.rawParameters = undefined;
      if (!tool.delegatedQuestion) {
        if (tool.deferredEmit) {
          tool.deferredEmit = false;
          this.emit({ type: 'tool-call', callId, toolName: tool.toolName, args: tool.args });
        }
        this.emit({
          type: 'tool-result',
          callId,
          toolName: tool.toolName,
          result: 'Completion was not reported. Background work may still be running.',
          isError: true,
        });
      }
      this.tools.delete(callId);
      this.trackCompletedTool(callId);
    }
  }

  private stopProcess(): void {
    this.workEpoch++;
    this.clearPostTurnQuestionTimer();
    this.taintedStreamLatch = false;
    this.taintedOutputRedacted = false;
    this.taintedThoughtRedacted = false;
    this.taintedOutputBuffer = '';
    this.taintedThoughtBuffer = '';
    this.promptRunning = false;
    this.sessionAcceptingEvents = false;
    this.pausedQuestionSession = false;
    this.backgroundRunning = false;
    this.backgroundStepDirty = false;
    this.supportsPostTurnFollowups = false;
    this.foregroundPermissions.clear();
    this.observerWake?.();
    this.drainingCancelTools?.();
    this.drainingCancelTools = null;
    if (!this.active && !this.cancelling && this.tools.size > 0) {
      this.closeUnresolvedTools();
    }
    this.rejectLifetime?.(new Error('Antigravity ACP process stopped'));
    this.rejectLifetime = undefined;
    this.stopHook?.close();
    this.stopHook = null;
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.appliedMode = this.appliedModel = null;
    this.permissionAbort.abort();
    this.options.resetPermissions?.();
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      const finished = () => { clearTimeout(timer); resolve(); };
      child.once('exit', finished);
      child.once('close', finished);
      child.kill('SIGTERM');
    });
    this.terminating.add(stopped);
    void stopped.then(() => this.terminating.delete(stopped));
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error('Antigravity backend is disposed');
    if (this.starting) return this.starting;
    if (this.connection && !this.connection.signal.aborted) return;
    this.starting = this.open();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async open(hookSetting: StopHookSetting = resolveAgyStopHookSetting(this.options.stopHook)): Promise<void> {
    this.stopProcess();
    this.permissionAbort = new AbortController();
    if (hookSetting === 'enabled' || hookSetting === 'observe' || hookSetting === 'continue'
      || (hookSetting === 'auto' && process.platform !== 'win32')) {
      this.stopHook = await AgyStopHook.create(
        this.options.stopHookLimits,
        hookSetting === 'observe' ? 'observe' : 'continue',
      );
      const createdHook = this.stopHook;
      createdHook.policy.subscribe(() => {
        const totalObs = createdHook.policy.totalObservations();
        for (const tool of this.tools.values()) {
          if (tool.isQuestion && tool.questionPending && tool.pendingAtObservations < totalObs) {
            tool.questionPending = false;
            tool.pendingEpoch = null;
            tool.questionAbort?.abort();
          }
        }
      });
      if (this.disposed || this.cancelled) { this.stopProcess(); throw new AgyCancelledError(); }
    }
    let child: ChildProcess;
    try {
      child = (this.options.spawnFn ?? spawn)(resolveAgyBin(), ['acp', '--add-dir', this.options.cwd,
        ...(this.stopHook ? ['--add-dir', this.stopHook.workspace] : [])], {
        cwd: this.options.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch { this.stopProcess(); throw new Error('Could not start Antigravity ACP; check HAPPY_AGY_PATH'); }
    this.child = child;
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Antigravity ACP stdio unavailable');
    // Never log raw stderr/protocol payloads: they may contain user files or credentials.
    child.stderr.on('data', () => {});
    const failed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new Error('Could not start Antigravity ACP; check HAPPY_AGY_PATH')));
      child.once('exit', () => {
        reject(new Error('Antigravity ACP process exited'));
        if (this.child === child) {
          this.clearPostTurnQuestionTimer();
          this.taintedStreamLatch = false;
          this.taintedOutputRedacted = false;
          this.taintedThoughtRedacted = false;
          this.taintedOutputBuffer = '';
          this.taintedThoughtBuffer = '';
          const hadPostTurnWork = !this.active && !this.cancelling && (this.backgroundRunning || this.tools.size > 0);
          this.promptRunning = false;
          this.sessionAcceptingEvents = false;
          this.pausedQuestionSession = false;
          this.backgroundRunning = false;
          this.backgroundStepDirty = false;
          this.supportsPostTurnFollowups = false;
          this.foregroundPermissions.clear();
          this.observerWake?.();
          this.drainingCancelTools?.();
          this.drainingCancelTools = null;
          if (!this.active && !this.cancelling && this.tools.size > 0) {
            this.closeUnresolvedTools();
          }
          if (hadPostTurnWork) {
            this.emit({ type: 'status', status: 'error', detail: 'Antigravity ACP process exited' });
          }
          this.stopHook?.close(); this.stopHook = null;
          this.connection = null;
          this.permissionAbort.abort();
          this.options.resetPermissions?.();
        }
      });
    });
    void failed.catch(() => {});
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async (notification) => { if (this.child === child) this.update(notification); },
      requestPermission: (request) => this.child === child ? this.permission(request)
        : Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
    }), ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    this.connection = connection;
    const closed = connection.closed.then(() => { throw new Error('Antigravity ACP connection closed'); });
    void closed.catch(() => {});
    const stopped = new Promise<never>((_, reject) => { this.rejectLifetime = reject; });
    this.lifetime = Promise.race([failed, closed, stopped]);
    void this.lifetime.catch(() => {});
    try {
      const initialized = await this.control(Promise.race([connection.initialize({
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'happy', version: '1' },
      }), this.lifetime]));
      this.capabilities = initialized.agentCapabilities ?? {};
      const reportedVersion = initialized.agentInfo?.version;
      const version = typeof reportedVersion === 'string' ? reportedVersion : undefined;
      const support = getAgyLifecycleSupport(version);
      this.supportsPostTurnFollowups = support === 'observer';
      if (this.stopHook) {
        if (hookSetting === 'auto' && support === 'native') {
          // AGY reads hook workspaces at startup, so reopen without the hook before creating or loading a session.
          return this.open('off');
        }
        if (support === 'unsupported' || support === 'native' || (hookSetting === 'observe' && support !== 'observer')) {
          const required = hookSetting === 'observe' ? '1.5.10' : '1.5.9';
          const actual = version && /^\d[0-9A-Za-z.+-]{0,79}$/.test(version) ? version : 'unknown';
          throw new AgyStopHookCompatibilityError(
            `AGY ${actual} is incompatible with Happy's Stop hook, which supports stable AGY >=${required} <1.6.0. `
            + 'Update Happy or set HAPPY_AGY_STOP_HOOK=0 to start without the hook.',
          );
        }
        this.stopHook.policy.setMode(support === 'observer' && hookSetting !== 'continue' ? 'observe' : 'continue');
      }
      if (this.sessionId) {
        if (!this.capabilities.loadSession) throw new Error('Antigravity does not support loading the requested ACP session');
        this.replaying = true;
        try {
          this.metadata = await this.control(Promise.race([connection.loadSession({
            sessionId: this.sessionId, cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [],
          }), this.lifetime]));
        } finally { this.replaying = false; }
      } else {
        const created = await this.control(Promise.race([connection.newSession({ cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [] }), this.lifetime]));
        this.sessionId = created.sessionId;
        this.metadata = created;
        this.tools.clear();
        this.completedTools.clear();
      }
      if (this.disposed || this.child !== child) throw new Error('Antigravity ACP connection closed');
      this.emit({ type: 'event', name: 'agy_session_id', payload: this.sessionId });
      this.options.log?.(`Antigravity ACP session connected: ${this.sessionId}`);
    } catch (error) { this.stopProcess(); throw error; }
  }

  async startSession(): Promise<{ sessionId: string }> {
    if (this.cancelling) await this.cancelling;
    if (!this.active) this.cancelled = false;
    try {
      await this.connect();
    } catch (error) {
      if (error instanceof AgyStopHookCompatibilityError) {
        this.emit({ type: 'status', status: 'error', detail: error.message });
      }
      throw error;
    }
    return { sessionId: this.sessionId! };
  }

  getSessionOptions(): Pick<Metadata, 'models' | 'operatingModes' | 'agyImageInput'> {
    return {
      agyImageInput: this.capabilities.promptCapabilities?.image === true,
      models: this.metadata.models?.availableModels.map(({ modelId, name, description }) => ({ code: modelId, value: name, description })),
      operatingModes: this.metadata.modes?.availableModes.map(({ id, name, description }) => ({ code: id, value: name, description }))
        ?? [{ code: 'default', value: 'Default' }],
    };
  }

  private async configure(): Promise<void> {
    const connection = this.connection!;
    const sessionId = this.sessionId!;
    if (this.model) {
      const requested = resolveAgyModelName(this.model, this.effort);
      const models = this.getSessionOptions().models ?? [];
      // Old chats may pin an exact native ID or display name, including its effort.
      let selected = models.find(model => model.code === this.model)?.code
        ?? models.find(model => model.value === this.model)?.code;
      if (!selected) {
        const group = groupAgyModels(models).find(model => model.key === this.model);
        const levels = AGY_EFFORT_LEVELS.filter(level => group?.variants.has(level));
        const effort = selectAgyEffort(levels, this.effort);
        selected = effort ? group?.variants.get(effort) : undefined;
      }
      if (!selected) throw new Error(`Antigravity ACP model is unavailable: ${requested}. Choose an available model for this session.`);
      if (selected !== this.appliedModel) {
        await this.control(Promise.race([connection.unstable_setSessionModel({ sessionId, modelId: selected }), this.lifetime]));
        this.appliedModel = selected;
      }
    }
    const modeId = this.mode === 'plan' || this.mode === 'read-only' ? 'plan'
      : this.mode === 'acceptEdits' ? 'accept-edits' : 'default';
    // Servers without optional ACP session modes run in their native default.
    if (!this.metadata.modes && modeId === 'default') return;
    if (modeId !== this.appliedMode) {
      if (!this.metadata.modes?.availableModes.some((mode) => mode.id === modeId)) throw new Error(`Antigravity ACP mode is unavailable: ${modeId}`);
      await this.control(Promise.race([connection.setSessionMode({ sessionId, modeId }), this.lifetime]));
      this.appliedMode = modeId;
    }
    // No set_config_option booleans: mode/model use their typed ACP methods.
  }

  async sendPrompt(_sessionId: SessionId, prompt: string, images: ContentBlock[] = [], signal?: AbortSignal): Promise<void> {
    if (this.cancelling) await this.cancelling;
    if (this.active) throw new Error('An Antigravity turn is already running');
    this.clearPostTurnQuestionTimer();
    this.cancelled = false;
    this.permissionDenied = false;
    this.backgroundRunning = false;
    this.backgroundStepDirty = false;
    const active = this.runPrompt(prompt, images, signal).finally(() => {
      if (this.active === active) this.active = null;
    });
    this.active = active;
    await active;
  }

  private async runPrompt(prompt: string, images: ContentBlock[], promptSignal?: AbortSignal): Promise<void> {
    let preserveBackgroundSession = false;
    let hookBegan = false;
    let promptStarted = false;
    this.emit({ type: 'status', status: 'running' });
    try {
      await this.connect();
      if (images.length && !this.capabilities.promptCapabilities?.image) throw new Error('Antigravity ACP does not support image input');
      await this.configure();
      if (this.cancelled || promptSignal?.aborted) throw new AgyCancelledError();
      const epoch = ++this.workEpoch;
      this.pausedQuestionSession = false;
      for (const [callId, tool] of this.tools) {
        if (tool.isQuestion) {
          tool.questionPending = false;
          tool.pendingEpoch = null;
          tool.questionAbort?.abort();
        } else if (!this.supportsPostTurnFollowups) {
          this.tools.delete(callId);
        }
      }
      // Drain any post-turn buffered output/thought chunks under the previous turn's
      // taint latch BEFORE resetting the latch for a clean subsequent turn.
      this.flushTaintedBuffers();
      this.taintedOutputRedacted = false;
      this.taintedThoughtRedacted = false;
      if (!this.hasUnresolvedQuestionPayload()) {
        this.taintedStreamLatch = false;
      }
      if (this.supportsPostTurnFollowups) {
        this.sessionAcceptingEvents = true;
      }
      const hook = this.stopHook;
      const turnBaselineObs = hook?.policy.totalObservations() ?? 0;
      if (hook) {
        hook.policy.begin(this.sessionId!);
        hookBegan = true;
      }
      promptStarted = true;
      this.promptRunning = true;
      const response = await Promise.race([this.connection!.prompt({
        sessionId: this.sessionId!, prompt: [{ type: 'text', text: this.options.initialPrompt && !this.initialPromptDelivered
          ? `${this.options.initialPrompt}\n\n${prompt}` : prompt }, ...images],
      }), this.lifetime]);
      if (this.cancelled || response.stopReason === 'cancelled') throw new AgyCancelledError();
      if (response.stopReason !== 'end_turn') throw new Error(`Antigravity stopped: ${response.stopReason}`);
      this.initialPromptDelivered = true;
      const isObserverHook = hook?.policy.getMode() === 'observe';
      if (hook && isObserverHook) {
        const initialSnap = hook.policy.snapshot();
        if (!initialSnap?.seen && this.permissionDenied && !this.hasPendingQuestionForEpoch(epoch, turnBaselineObs)) {
          throw new Error('Antigravity stopped after a tool permission was denied. The denied action was not approved.'
            + (this.hasAnyOpenActiveTools() ? ' Other background work may still be running; completion is unconfirmed.' : ''));
        }
        if (initialSnap?.seen && !initialSnap.issue && initialSnap.fullyIdle === false) {
          this.emit({ type: 'event', name: 'agy_step_complete', payload: null });
          this.permissionDenied = false;
          await Promise.race([this.waitForObservedIdle(hook, epoch), this.lifetime]);
          if (this.cancelled) throw new AgyCancelledError();
        } else if (
          !initialSnap?.issue
          && (initialSnap?.seen ? initialSnap.fullyIdle === true : this.hasPendingQuestionForEpoch(epoch, turnBaselineObs))
          && this.hasOpenActiveForegroundTools(epoch)
        ) {
          // Cross-FD / parallel-tool sync: give stdout pipe a brief settle if Stop or
          // ask_question end_turn arrived just ahead of a sibling tool_call_update(completed).
          await Promise.race([this.waitForPipeToolSync(epoch), this.lifetime]);
          if (this.cancelled) throw new AgyCancelledError();
        }
      } else if (this.hasPendingQuestionForEpoch(epoch) && this.hasOpenActiveForegroundTools(epoch)) {
        await Promise.race([this.waitForPipeToolSync(epoch), this.lifetime]);
        if (this.cancelled) throw new AgyCancelledError();
      }
      // AGY pauses on `ask_question` and returns `end_turn` without invoking `Stop`.
      // Exempt missing `Stop` / prior `fullyIdle=false` only when a question entered
      // `status: "pending"` during this turn's latest observation, no other active
      // non-daemon tools or permission prompts remain open, and the hook reported no issue.
      const preFinishSnap = hook?.policy.snapshot();
      const currentTotalObs = hook?.policy.totalObservations();
      const pausedForQuestion = this.hasPendingQuestionForEpoch(epoch, currentTotalObs)
        && !this.hasAnyOpenActiveTools()
        && this.pendingPermissions === 0
        && !preFinishSnap?.issue;
      if (pausedForQuestion) {
        this.promoteDeferredQuestionTools(epoch, currentTotalObs);
      }
      const hookIssue = hook?.policy.finish({ allowQuestionPause: pausedForQuestion });
      const state = hook?.policy.snapshot();
      if (hook) {
        if (isObserverHook) {
          this.options.log?.(`Antigravity Stop hook: 0 continuations, mode=observe, observations=${state?.observations ?? 0}, idle=${state?.fullyIdle ?? 'unknown'}`);
        } else {
          this.options.log?.(`Antigravity Stop hook: ${state?.count ?? 0} continuations, idle=${state?.fullyIdle ?? 'unknown'}`);
        }
      }
      // Rejection sometimes skips Stop entirely. A valid final idle observation
      // or subsequent ask_question fallback still permits a graceful turn pause.
      if (hook && this.permissionDenied && !state?.seen && !pausedForQuestion) {
        throw new Error('Antigravity stopped after a tool permission was denied. The denied action was not approved.'
          + (this.hasAnyOpenActiveTools() ? ' Other background work may still be running; completion is unconfirmed.' : ''));
      }
      if (hookIssue) throw new Error(`${hookIssue}. Completion is unconfirmed; background work may still be running.`);
      const hasUnfinishedForegroundWork = this.supportsPostTurnFollowups
        ? (this.hasOpenActiveForegroundTools(epoch) || this.hasOpenForegroundPermissions(epoch))
        : (this.hasAnyOpenActiveTools() || this.pendingPermissions > 0);
      if (hasUnfinishedForegroundWork) {
        if (this.supportsPostTurnFollowups && !hook) {
          preserveBackgroundSession = true;
          this.emit({ type: 'event', name: 'agy_step_complete', payload: null });
        }
        throw new Error('Antigravity ended its response before all tool results arrived. Work may still be running; completion is unconfirmed.');
      }
      this.reapStaleQuestions(epoch);
      this.flushTaintedBuffers();
      this.settleDaemonTools();
      if (this.supportsPostTurnFollowups) {
        preserveBackgroundSession = true;
        this.sessionAcceptingEvents = true;
      }
      if (pausedForQuestion) {
        preserveBackgroundSession = true;
        this.pausedQuestionSession = true;
      }
      this.emit({ type: 'status', status: 'idle' });
    } catch (error) {
      const isCancel = this.cancelled || error instanceof AgyCancelledError;
      if (this.stopHook) {
        const snap = this.stopHook.policy.snapshot();
        const dirtyObserverTurn = promptStarted && (
          (hookBegan && (!snap?.seen || snap.fullyIdle !== true || Boolean(snap.issue)))
          || this.hasAnyOpenActiveTools()
          || this.pendingPermissions > 0
        );
        if (!isCancel && ((hookBegan && this.stopHook.policy.getMode() === 'continue') || dirtyObserverTurn)) {
          preserveBackgroundSession = false;
          this.stopProcess();
        }
      } else if (!isCancel && promptStarted && !preserveBackgroundSession && (this.pendingPermissions > 0 || !this.supportsPostTurnFollowups)) {
        this.stopProcess();
      }
      if (isCancel) {
        if (
          !this.cancelled
          && !promptStarted
          && this.connection
          && !this.connection.signal.aborted
          && (this.supportsPostTurnFollowups || (!this.hasAnyOpenActiveTools() && this.pausedQuestionSession))
        ) {
          preserveBackgroundSession = true;
          if (this.supportsPostTurnFollowups) {
            this.sessionAcceptingEvents = true;
          }
        } else {
          preserveBackgroundSession = false;
        }
        throw new AgyCancelledError();
      }
      if (!this.connection || this.connection.signal.aborted) {
        preserveBackgroundSession = false;
      } else if (!promptStarted && (this.supportsPostTurnFollowups || (!this.hasAnyOpenActiveTools() && this.pausedQuestionSession))) {
        // Pre-prompt validation errors (unsupported image, unavailable model/mode)
        // never entered a prompt; preserve the idle/paused session and open questions.
        preserveBackgroundSession = true;
        if (this.supportsPostTurnFollowups) {
          this.sessionAcceptingEvents = true;
        }
      }
      const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Antigravity ACP failed';
      const detail = sanitizeDiagnosticText(message, 2_000);
      this.emit({ type: 'status', status: 'error', detail });
      throw new Error(detail);
    } finally {
      this.promptRunning = false;
      this.stopHook?.policy.cancel();
      if (!preserveBackgroundSession) {
        this.sessionAcceptingEvents = false;
        this.pausedQuestionSession = false;
        // When cancelActive() is running, let cancelActive() drain cooperative
        // tool_call_update(failed) notifications before closing leftover cards.
        if (!this.cancelling) {
          this.closeUnresolvedTools();
          this.permissionAbort.abort();
          this.permissionAbort = new AbortController();
          this.options.resetPermissions?.();
        }
      }
    }
  }

  private waitForPipeToolSync(epoch: number): Promise<void> {
    const syncMs = Math.max(20, (this.options.observerSettleMs ?? 25) * 4);
    return new Promise<void>((resolve) => {
      if (!this.hasOpenActiveForegroundTools(epoch)) { resolve(); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (this.observerWake === wake) this.observerWake = null;
        resolve();
      };
      const wake = () => {
        if (this.cancelled || this.disposed || !this.hasOpenActiveForegroundTools(epoch)) done();
      };
      this.observerWake = wake;
      timer = setTimeout(done, syncMs);
    });
  }

  private waitForObservedIdle(hook: AgyStopHook, epoch: number): Promise<void> {
    const maxWaitMs = Math.max(50, this.options.stopHookLimits?.maxContinuationMs ?? STOP_HOOK_LIMITS.maxContinuationMs);
    const denialSettleMs = Math.max(20, this.options.permissionDenialSettleMs ?? 1_500);
    const settleMs = Math.max(0, this.options.observerSettleMs ?? 25);
    const pipeSyncMs = Math.max(80, settleMs * 4);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastObservations = hook.policy.snapshot()?.observations ?? 1;
      let lastProgress = hook.policy.snapshot()?.progress ?? 0;
      let lastQuestionSeq = this.questionActivitySeq;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let denialTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let pipeSyncTimer: ReturnType<typeof setTimeout> | undefined;
      let questionSettleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(denialTimer);
        clearTimeout(settleTimer);
        clearTimeout(pipeSyncTimer);
        clearTimeout(questionSettleTimer);
        unsubscribe();
        if (this.observerWake === evaluate) this.observerWake = null;
      };

      const resetDeadline = () => {
        clearTimeout(deadlineTimer);
        deadlineTimer = setTimeout(() => {
          hook.policy.failWith('continuation time limit reached');
        }, maxWaitMs);
      };

      const evaluate = () => {
        if (settled) return;
        if (this.cancelled || this.disposed) {
          cleanup();
          reject(new AgyCancelledError());
          return;
        }
        const state = hook.policy.snapshot();
        if (!state || !state.active || state.issue) {
          cleanup();
          resolve();
          return;
        }
        if (state.progress !== lastProgress) {
          lastProgress = state.progress;
          resetDeadline();
        }
        if (this.questionActivitySeq !== lastQuestionSeq) {
          lastQuestionSeq = this.questionActivitySeq;
          clearTimeout(questionSettleTimer);
          questionSettleTimer = undefined;
        }
        if (state.observations > lastObservations) {
          lastObservations = state.observations;
          this.permissionDenied = false;
          clearTimeout(denialTimer);
          denialTimer = undefined;
          if (state.fullyIdle === false) {
            for (const tool of this.tools.values()) {
              if (tool.isQuestion && tool.pendingAtObservations < state.observations) {
                tool.questionPending = false;
              }
            }
            this.emit({ type: 'event', name: 'agy_step_complete', payload: null });
          }
        }
        // AGY 1.5.10 skips Stop when a reactive-wakeup permission request is rejected.
        const currentTotalObs = hook.policy.totalObservations();
        if (!this.permissionDenied || this.pendingPermissions > 0 || this.hasPendingQuestionForEpoch(epoch, currentTotalObs)) {
          clearTimeout(denialTimer);
          denialTimer = undefined;
        } else if (state.fullyIdle !== true && !denialTimer) {
          denialTimer = setTimeout(() => {
            denialTimer = undefined;
            const latestTotalObs = hook.policy.totalObservations();
            if (settled || !this.permissionDenied || this.pendingPermissions > 0 || this.hasPendingQuestionForEpoch(epoch, latestTotalObs)) return;
            cleanup();
            reject(new Error('Antigravity stopped after a tool permission was denied. The denied action was not approved.'
              + (this.hasAnyOpenActiveTools() ? ' Other background work may still be running; completion is unconfirmed.' : '')));
          }, denialSettleMs);
        }
        if (state.fullyIdle === true) {
          clearTimeout(denialTimer);
          denialTimer = undefined;
          clearTimeout(questionSettleTimer);
          questionSettleTimer = undefined;
          if (this.pendingPermissions === 0 && !this.hasOpenActiveForegroundTools(epoch) && !this.hasAnyOpenActiveTools()) {
            clearTimeout(pipeSyncTimer);
            pipeSyncTimer = undefined;
            if (!settleTimer) {
              settleTimer = setTimeout(() => {
                settleTimer = undefined;
                if (settled) return;
                if (this.cancelled || this.disposed) {
                  cleanup();
                  reject(new AgyCancelledError());
                  return;
                }
                const latest = hook.policy.snapshot();
                if (!latest || !latest.active || latest.issue
                  || (latest.fullyIdle === true && this.pendingPermissions === 0 && !this.hasAnyOpenActiveTools())) {
                  cleanup();
                  resolve();
                }
              }, settleMs);
            }
          } else {
            clearTimeout(settleTimer);
            settleTimer = undefined;
            if (this.pendingPermissions === 0 && !pipeSyncTimer) {
              pipeSyncTimer = setTimeout(() => {
                pipeSyncTimer = undefined;
                if (settled) return;
                const latest = hook.policy.snapshot();
                if (latest?.fullyIdle === true && this.pendingPermissions === 0) {
                  cleanup();
                  resolve();
                }
              }, pipeSyncMs);
            }
          }
        } else {
          clearTimeout(settleTimer);
          settleTimer = undefined;
          clearTimeout(pipeSyncTimer);
          pipeSyncTimer = undefined;
          // Reactive wakeups that call `ask_question` pause on `status: "pending"`
          // without invoking `Stop` a second time. Debounce until trailing question
          // markdown chunks settle before concluding the turn.
          if (this.hasPendingQuestionForEpoch(epoch, currentTotalObs) && !this.hasAnyOpenActiveTools() && this.pendingPermissions === 0) {
            if (!questionSettleTimer) {
              questionSettleTimer = setTimeout(() => {
                questionSettleTimer = undefined;
                if (settled) return;
                if (this.cancelled || this.disposed) {
                  cleanup();
                  reject(new AgyCancelledError());
                  return;
                }
                const latest = hook.policy.snapshot();
                const latestTotalObs = hook.policy.totalObservations();
                if (!latest || !latest.active || latest.issue
                  || (this.hasPendingQuestionForEpoch(epoch, latestTotalObs) && !this.hasAnyOpenActiveTools() && this.pendingPermissions === 0)) {
                  cleanup();
                  resolve();
                }
              }, pipeSyncMs);
            }
          } else {
            clearTimeout(questionSettleTimer);
            questionSettleTimer = undefined;
          }
        }
      };

      this.observerWake = evaluate;
      const unsubscribe = hook.policy.subscribe(evaluate);
      resetDeadline();
      evaluate();
    });
  }

  private update({ sessionId, update }: SessionNotification): void {
    if (this.cancelling) {
      if (
        sessionId === this.sessionId
        && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
        && (update.status === 'completed' || update.status === 'failed')
      ) {
        const callId = update.toolCallId;
        const tool = this.tools.get(callId);
        if (tool) {
          if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen || hasQuestionCredentialCarrier(update.rawInput))) {
            this.taintedStreamLatch = true;
          }
          tool.questionAbort?.abort();
          tool.rawParameters = undefined;
          if (!tool.delegatedQuestion) {
            if (tool.deferredEmit) {
              tool.deferredEmit = false;
              this.emit({ type: 'tool-call', callId, toolName: tool.toolName, args: tool.args });
            }
            this.emit({
              type: 'tool-result',
              callId,
              toolName: tool.toolName,
              result: update.status === 'failed' ? 'Antigravity tool failed.' : null,
              isError: update.status === 'failed',
            });
          }
          this.tools.delete(callId);
          this.trackCompletedTool(callId);
          if (!this.hasAnyOpenNonDaemonTools()) {
            this.drainingCancelTools?.();
          }
        }
      }
      return;
    }
    if (this.replaying || this.cancelled || this.disposed || sessionId !== this.sessionId || (!this.promptRunning && !this.sessionAcceptingEvents)) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (update.content.text && this.permissionDenied) {
        this.permissionDenied = false;
        this.observerWake?.();
      }
      if (!this.promptRunning && update.content.text) {
        if (!this.backgroundRunning) {
          this.backgroundRunning = true;
          this.emit({ type: 'status', status: 'running' });
        }
        this.backgroundStepDirty = true;
      }
      if (this.shouldBufferQuestionStream()) {
        if (update.content.text) {
          this.taintedOutputBuffer = (this.taintedOutputBuffer + update.content.text).slice(-256 * 1024);
        }
      } else {
        this.emit({ type: 'model-output', textDelta: update.content.text });
      }
      if (update.content.text && this.hasOpenQuestionTools()) {
        this.questionActivitySeq++;
        this.observerWake?.();
        if (!this.promptRunning && this.hasPendingQuestionTools()) {
          this.schedulePostTurnQuestionSettle();
        }
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      if (update.content.text && this.permissionDenied) {
        this.permissionDenied = false;
        this.observerWake?.();
      }
      if (!this.promptRunning && update.content.text) {
        if (!this.backgroundRunning) {
          this.backgroundRunning = true;
          this.emit({ type: 'status', status: 'running' });
        }
        this.backgroundStepDirty = true;
      }
      if (this.shouldBufferQuestionStream()) {
        if (update.content.text) {
          this.taintedThoughtBuffer = (this.taintedThoughtBuffer + update.content.text).slice(-256 * 1024);
        }
      } else {
        this.emit({ type: 'event', name: 'thinking', payload: { text: update.content.text, streaming: true } });
      }
      if (update.content.text && this.hasOpenQuestionTools()) {
        this.questionActivitySeq++;
        this.observerWake?.();
        if (!this.promptRunning && this.hasPendingQuestionTools()) {
          this.schedulePostTurnQuestionSettle();
        }
      }
    } else if (update.sessionUpdate === 'usage_update') {
      if (!this.promptRunning) {
        if (this.backgroundStepDirty && !this.shouldBufferQuestionStream()) {
          this.flushTaintedBuffers();
          this.backgroundStepDirty = false;
          this.emit({ type: 'event', name: 'agy_step_complete', payload: null });
        }
        if (this.backgroundRunning && !this.hasAnyOpenActiveTools() && this.pendingPermissions === 0 && !this.hasOpenQuestionTools()) {
          this.backgroundRunning = false;
        }
      }
      if (this.hasOpenQuestionTools()) {
        this.questionActivitySeq++;
        this.observerWake?.();
        if (!this.promptRunning && this.hasPendingQuestionTools()) {
          this.schedulePostTurnQuestionSettle();
        }
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const callId = update.toolCallId;
      if (this.completedTools.has(callId)) return;
      if (!this.promptRunning) {
        this.backgroundStepDirty = false;
        if (!this.backgroundRunning && update.status !== 'completed' && update.status !== 'failed') {
          this.backgroundRunning = true;
          this.emit({ type: 'status', status: 'running' });
        }
      }
      if (!this.tools.has(callId)) {
        const { nativeName, isDaemon, rawParameters, display } = this.describeTool(update);
        const isQuestion = nativeName.toLowerCase() === 'ask_question';
        const taintedQuestion = isQuestion && hasQuestionCredentialCarrier(rawParameters);
        if (taintedQuestion) {
          this.taintedStreamLatch = true;
        }
        const deferredEmit = isQuestion
          && Boolean(this.options.onQuestion)
          && update.status !== 'completed'
          && update.status !== 'failed';
        const payloadSeen = isQuestion && this.hasQuestionPayload(rawParameters);
        this.tools.set(callId, {
          toolName: display.toolName,
          nativeName,
          args: { ...display.args },
          ...(deferredEmit ? { rawParameters: { ...rawParameters } } : {}),
          commandExecution: PROGRESS_NATIVE_TOOLS.has(nativeName.toLowerCase()),
          isDaemon,
          isQuestion,
          payloadSeen,
          startedIncomplete: isQuestion && !payloadSeen,
          taintedQuestion,
          questionPending: false,
          pendingEpoch: null,
          pendingAtObservations: 0,
          deferredEmit,
          delegatedQuestion: false,
          ownerEpoch: this.workEpoch,
        });
        if (!deferredEmit) {
          this.emit({ type: 'tool-call', callId, ...display });
        }
      } else {
        const existing = this.tools.get(callId)!;
        if (existing.isQuestion && isPlainRecord(update.rawInput)) {
          const fallbackRawInput = { name: existing.nativeName, ...update.rawInput };
          const { rawParameters, display } = this.describeTool({
            ...update,
            kind: update.kind ?? 'other',
            rawInput: fallbackRawInput,
          });
          if (this.hasQuestionPayload(rawParameters)) {
            existing.payloadSeen = true;
          }
          if (hasQuestionCredentialCarrier(rawParameters)) {
            existing.taintedQuestion = true;
            this.taintedStreamLatch = true;
          }
          if (existing.deferredEmit) {
            existing.rawParameters = mergeDefinedArgs(existing.rawParameters ?? {}, rawParameters);
            if (this.hasQuestionPayload(existing.rawParameters)) {
              existing.payloadSeen = true;
            }
          }
          const mergedArgs = mergeDefinedArgs(existing.args, display.args);
          if (!argsEqual(existing.args, mergedArgs)) {
            existing.args = mergedArgs;
            if (!existing.deferredEmit && !existing.delegatedQuestion) {
              this.emit({ type: 'tool-call', callId, toolName: existing.toolName, args: existing.args });
            }
          }
          if (!this.promptRunning && existing.questionPending) {
            this.schedulePostTurnQuestionSettle();
          }
        } else if (
          (existing.toolName === 'Edit' || existing.toolName === 'MultiEdit' || existing.toolName === 'Write')
          && (Array.isArray(update.content) || isPlainRecord(update.rawInput))
        ) {
          const fallbackRawInput = isPlainRecord(update.rawInput)
            ? { name: existing.nativeName, ...update.rawInput }
            : { name: existing.nativeName };
          const { nativeName, display } = this.describeTool({
            ...update,
            kind: update.kind ?? 'edit',
            rawInput: fallbackRawInput,
          });
          const mergedArgs = mergeDefinedArgs(existing.args, display.args);
          if (display.toolName !== existing.toolName || !argsEqual(existing.args, mergedArgs)) {
            existing.toolName = display.toolName;
            existing.nativeName = nativeName;
            existing.args = mergedArgs;
            this.emit({ type: 'tool-call', callId, toolName: existing.toolName, args: existing.args });
          }
        }
        if (existing.isQuestion && update.status === 'in_progress') {
          existing.questionPending = false;
          existing.pendingEpoch = null;
          existing.questionAbort?.abort();
        }
      }
      const currentTool = this.tools.get(callId);
      if (currentTool?.isQuestion && update.status === 'pending') {
        currentTool.questionPending = true;
        currentTool.pendingEpoch = this.workEpoch;
        currentTool.pendingAtObservations = this.stopHook?.policy.totalObservations() ?? 0;
        this.permissionDenied = false;
        this.questionActivitySeq++;
        this.observerWake?.();
        if (!this.promptRunning) {
          this.schedulePostTurnQuestionSettle();
        }
      }
      if (update.status === 'completed' || update.status === 'failed') {
        // Raw outputs may contain entire files/secrets. Happy currently renders lifecycle only.
        const tool = this.tools.get(callId)!;
        const hadBufferedQuestion = tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen || tool.startedIncomplete);
        if (tool.isQuestion && (tool.taintedQuestion || !tool.payloadSeen)) {
          this.taintedStreamLatch = true;
        }
        tool.questionPending = false;
        tool.pendingEpoch = null;
        tool.rawParameters = undefined;
        tool.parsedQuestions = undefined;
        tool.questionAbort?.abort();
        if (!tool.delegatedQuestion) {
          if (tool.deferredEmit) {
            tool.deferredEmit = false;
            this.emit({ type: 'tool-call', callId, toolName: tool.toolName, args: tool.args });
          }
          this.emit({ type: 'tool-result', callId, toolName: tool.toolName, result: update.status === 'failed' ? 'Antigravity tool failed.' : null, isError: update.status === 'failed' });
        }
        // Status/wait tools and failed actions do not prove the background command
        // made progress. They must not indefinitely reset the no-progress allowance.
        if (update.status === 'completed' && tool.commandExecution) this.stopHook?.policy.progress();
        this.tools.delete(callId);
        this.trackCompletedTool(callId);
        if (hadBufferedQuestion && !this.shouldBufferQuestionStream()) {
          this.flushTaintedBuffers();
        }
        this.observerWake?.();
        if (!this.promptRunning && this.hasPendingQuestionTools()) {
          this.schedulePostTurnQuestionSettle();
        }
      }
    }
  }

  private describeTool(update: RequestPermissionRequest['toolCall']) {
    const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : {};
    const diffBlock = Array.isArray(update.content)
      ? update.content.find((item): item is Extract<ToolCallContent, { type: 'diff' }> =>
          isPlainRecord(item)
          && item.type === 'diff'
          && typeof item.path === 'string'
          && typeof item.newText === 'string')
      : undefined;
    // ACP titles are human labels ('File README.md', 'sleep 2'), not tool IDs.
    const kindTool: Record<string, string> = { read: 'read_file', edit: 'edit_file', execute: 'run_command', fetch: 'read_url_content' };
    // Antigravity 1.5.9 labels MCP calls as kind=other and omits their name in rawInput.
    // Match only the exact native label for our configured Happy server.
    const isHappyTitle = this.options.mcpServers?.some(server => server.name === 'happy')
      && update.title === 'Run mcp_happy_change_title';
    const parameters = isPlainRecord(input.parameters) ? input.parameters
      : isPlainRecord(input.arguments) ? input.arguments
      : isPlainRecord(input.args) ? input.args : input;
    // ACP kind is a broad category: web, content and filename searches all use
    // "search". Native argument shapes distinguish them when no tool ID exists.
    const searchTool = typeof parameters.query === 'string' ? 'search_web'
      : typeof parameters.Pattern === 'string' ? 'find_by_name'
      : typeof parameters.Query === 'string' ? 'grep_search' : 'search';
    const hasExplicitWriteBody = typeof parameters.Content === 'string'
      || typeof parameters.CodeContent === 'string'
      || typeof parameters.content === 'string';
    const hasExplicitEditBody = typeof parameters.Target === 'string'
      || typeof parameters.TargetContent === 'string'
      || typeof parameters.old_string === 'string'
      || Array.isArray(parameters.ReplacementChunks);
    const editTool = hasExplicitWriteBody && !hasExplicitEditBody
      ? 'write_file'
      : diffBlock && (diffBlock.oldText === null || diffBlock.oldText === undefined) && !hasExplicitEditBody
        ? 'write_file'
        : 'edit_file';
    const titleId = /^Run ([a-z][a-z0-9_]*)$/.exec(update.title ?? '')?.[1];
    const nativeTitle = (!update.kind || update.kind === 'other') && titleId && NATIVE_TOOL_LABELS.has(titleId)
      ? titleId : undefined;
    const explicitInputName = typeof input.name === 'string' ? input.name : undefined;
    // When updating a generic kind=edit tool that originally had no explicit native name,
    // allow diffBlock with oldText=null to refine edit_file -> write_file.
    const resolvedInputName = explicitInputName === 'edit_file' && editTool === 'write_file'
      ? 'write_file'
      : explicitInputName;
    const name = isHappyTitle ? 'mcp__happy__change_title' : resolvedInputName
      ? resolvedInputName
      : nativeTitle ? nativeTitle
      : update.kind === 'search' ? searchTool
      : update.kind === 'edit' ? editTool
      : update.kind ? kindTool[update.kind] ?? update.kind : 'agy_tool';
    const isDaemon = (name === 'run_command' || name === 'schedule') && parameters.IsDaemon === true;
    const diffFallback: Record<string, unknown> = diffBlock
      ? {
          Path: diffBlock.path,
          ...(typeof diffBlock.oldText === 'string' ? { Target: diffBlock.oldText } : {}),
          Replacement: diffBlock.newText,
          Content: diffBlock.newText,
        }
      : {};
    const definedParameters = Object.fromEntries(
      Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null),
    );
    const mergedParameters = diffBlock ? { ...diffFallback, ...definedParameters } : parameters;
    return {
      nativeName: name,
      isDaemon,
      rawParameters: isPlainRecord(mergedParameters) ? mergedParameters : {},
      display: mapAgyToolToDisplay(name, mergedParameters),
    };
  }

  private async permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (request.sessionId !== this.sessionId || this.cancelled || this.disposed || this.cancelling || (!this.promptRunning && !this.sessionAcceptingEvents)) return cancelled;
    const signal = this.permissionAbort.signal;
    if (signal.aborted) return cancelled;
    if (!this.promptRunning && !this.backgroundRunning) {
      this.backgroundRunning = true;
      this.emit({ type: 'status', status: 'running' });
    }
    const permEpoch = this.promptRunning ? this.workEpoch : -1;
    if (permEpoch >= 0) {
      this.foregroundPermissions.set(permEpoch, (this.foregroundPermissions.get(permEpoch) ?? 0) + 1);
    }
    this.pendingPermissions++;
    this.observerWake?.();
    let abort: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const bypass = this.mode === 'yolo' || this.mode === 'bypassPermissions';
      const { display } = this.describeTool(request.toolCall);
      const result = bypass ? { decision: 'approved' as const } : this.options.requestPermission
        ? await Promise.race([this.options.requestPermission(request.toolCall.toolCallId, display.toolName, display.args), aborted])
        : { decision: 'denied' as const };
      if (!result || this.cancelled || this.disposed || signal.aborted || (!this.promptRunning && !this.sessionAcceptingEvents) || result.decision === 'abort') return cancelled;
      const approved = result.decision === 'approved' || result.decision === 'approved_for_session';
      this.permissionDenied = !approved;
      const option = request.options.find((option) => option.kind === (approved ? 'allow_once' : 'reject_once'));
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
    } catch { return cancelled; }
    finally {
      this.pendingPermissions = Math.max(0, this.pendingPermissions - 1);
      if (permEpoch >= 0) {
        const nextCount = (this.foregroundPermissions.get(permEpoch) ?? 1) - 1;
        if (nextCount <= 0) this.foregroundPermissions.delete(permEpoch);
        else this.foregroundPermissions.set(permEpoch, nextCount);
      }
      if (abort) signal.removeEventListener('abort', abort);
      this.observerWake?.();
      if (!this.promptRunning && this.hasPendingQuestionTools()) {
        this.schedulePostTurnQuestionSettle();
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    if (!this.active && !this.sessionAcceptingEvents && !this.pausedQuestionSession) return;
    this.cancelling = this.cancelActive();
    try { await this.cancelling; } finally { this.cancelling = null; }
  }

  private async cancelActive(): Promise<void> {
    const active = this.active;
    const hadPostTurnSession = !active && this.sessionAcceptingEvents;
    const hadPausedQuestion = !active && this.pausedQuestionSession;
    if (!active && !hadPostTurnSession && !hadPausedQuestion) return;
    const hookSnapBeforeCancel = this.stopHook?.policy.snapshot();
    const hadToollessBackgroundWait = Boolean(
      hookSnapBeforeCancel?.seen
      && hookSnapBeforeCancel.fullyIdle === false
      && !this.hasAnyOpenActiveTools(),
    );
    this.workEpoch++;
    this.clearPostTurnQuestionTimer();
    this.taintedStreamLatch = false;
    this.taintedOutputRedacted = false;
    this.taintedThoughtRedacted = false;
    this.taintedOutputBuffer = '';
    this.taintedThoughtBuffer = '';
    this.cancelled = true;
    this.promptRunning = false;
    this.sessionAcceptingEvents = false;
    this.pausedQuestionSession = false;
    this.backgroundRunning = false;
    this.backgroundStepDirty = false;
    this.stopHook?.policy.cancel();
    this.observerWake?.();
    this.permissionAbort.abort();
    this.options.resetPermissions?.();
    try {
      if (this.connection && this.sessionId) await this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (active) {
          await Promise.race([active.catch(() => {}), new Promise<void>((resolve) => {
            timer = setTimeout(() => { this.stopProcess(); resolve(); }, this.options.cancelGraceMs ?? 5_000);
          })]);
          // stopProcess rejects the logical connection immediately, independently
          // of a slow child exit. Drain the turn's finally before accepting a new one.
          await active.catch(() => {});
        }
        if (this.hasAnyOpenNonDaemonTools() && this.connection && !this.connection.signal.aborted) {
          clearTimeout(timer);
          await Promise.race([
            new Promise<void>((resolve) => {
              this.drainingCancelTools = resolve;
              if (!this.hasAnyOpenNonDaemonTools()) resolve();
            }),
            this.lifetime.catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => { this.stopProcess(); resolve(); }, this.options.cancelGraceMs ?? 5_000);
            }),
          ]);
        }
      } finally { clearTimeout(timer); }
    } finally {
      this.drainingCancelTools = null;
      this.closeUnresolvedTools();
      // Legacy forced-continuation hooks can have an in-flight shell script, and
      // toolless background waits (subagents/timers/reactive streams) emit no
      // tool_call_update(failed) barrier on session/cancel; retire and reload cleanly.
      if (this.stopHook && (this.stopHook.policy.getMode() === 'continue' || hadToollessBackgroundWait)) {
        this.stopProcess();
      }
      this.permissionAbort = new AbortController();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelled = true;
    this.stopProcess();
    this.handlers.clear();
    await Promise.all(this.terminating);
  }
}
