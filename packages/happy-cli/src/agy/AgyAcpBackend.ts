/** Persistent Antigravity ACP adapter, isolated from the generic ACP backend. */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream,
  type McpServer, type ContentBlock, type NewSessionResponse, type SessionNotification,
  type RequestPermissionRequest, type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { PermissionMode } from '@/api/types';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { resolveAgyBin, resolveAgyModelName } from './constants';
import { isPlainRecord, mapAgyToolToDisplay, sanitizeDiagnosticText } from './toolDisplay';

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
  spawnFn?: typeof spawn;
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
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
  private lifetime: Promise<never> = new Promise(() => {});
  private cancelled = false;
  private disposed = false;
  private replaying = false;
  private tools = new Map<string, string>();
  private completedTools = new Set<string>();
  private terminating = new Set<Promise<void>>();
  private permissionAbort = new AbortController();
  private mode: PermissionMode;
  private model?: string;
  private effort?: string;
  private appliedModel: string | null = null;
  private appliedMode: string | null = null;
  private initialPromptDelivered = false;

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

  private stopProcess(): void {
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

  private async open(): Promise<void> {
    this.stopProcess();
    this.permissionAbort = new AbortController();
    const child = (this.options.spawnFn ?? spawn)(resolveAgyBin(), ['acp', '--add-dir', this.options.cwd], {
      cwd: this.options.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Antigravity ACP stdio unavailable');
    // Never log raw stderr/protocol payloads: they may contain user files or credentials.
    child.stderr.on('data', () => {});
    const failed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new Error('Could not start Antigravity ACP; check HAPPY_AGY_PATH')));
      child.once('exit', () => {
        reject(new Error('Antigravity ACP process exited'));
        if (this.child === child) {
          this.connection = null;
          this.permissionAbort.abort();
          this.options.resetPermissions?.();
        }
      });
    });
    void failed.catch(() => {});
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async (notification) => this.update(notification),
      requestPermission: (request) => this.permission(request),
    }), ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    this.connection = connection;
    const closed = connection.closed.then(() => { throw new Error('Antigravity ACP connection closed'); });
    void closed.catch(() => {});
    this.lifetime = Promise.race([failed, closed]);
    void this.lifetime.catch(() => {});
    try {
      const initialized = await this.control(Promise.race([connection.initialize({
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'happy', version: '1' },
      }), this.lifetime]));
      this.capabilities = initialized.agentCapabilities ?? {};
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
      }
      if (this.disposed || this.child !== child) throw new Error('Antigravity ACP connection closed');
      this.emit({ type: 'event', name: 'agy_session_id', payload: this.sessionId });
      this.options.log?.(`Antigravity ACP session connected: ${this.sessionId}`);
    } catch (error) { this.stopProcess(); throw error; }
  }

  async startSession(): Promise<{ sessionId: string }> {
    await this.connect();
    return { sessionId: this.sessionId! };
  }

  private async configure(): Promise<void> {
    const connection = this.connection!;
    const sessionId = this.sessionId!;
    if (this.model) {
      const requested = resolveAgyModelName(this.model, this.effort);
      const selected = this.metadata.models?.availableModels.find((model) => model.modelId === requested || model.name === requested);
      if (!selected) throw new Error(`Antigravity ACP model is unavailable: ${requested}`);
      if (selected.modelId !== this.appliedModel) {
        await this.control(Promise.race([connection.unstable_setSessionModel({ sessionId, modelId: selected.modelId }), this.lifetime]));
        this.appliedModel = selected.modelId;
      }
    }
    const modeId = this.mode === 'plan' || this.mode === 'read-only' ? 'plan'
      : this.mode === 'acceptEdits' ? 'accept-edits' : 'default';
    if (modeId !== this.appliedMode) {
      // Session modes are optional in ACP (agy 1.4.12 omits them). Keep the
      // native default without calling an unsupported method. Explicit mode
      // requests must still be advertised; never silently drop restrictions.
      if (!this.metadata.modes && modeId === 'default') {
        this.appliedMode = modeId;
        return;
      }
      if (!this.metadata.modes?.availableModes.some((mode) => mode.id === modeId)) throw new Error(`Antigravity ACP mode is unavailable: ${modeId}`);
      await this.control(Promise.race([connection.setSessionMode({ sessionId, modeId }), this.lifetime]));
      this.appliedMode = modeId;
    }
    // No set_config_option booleans: mode/model use their typed ACP methods.
  }

  async sendPrompt(_sessionId: SessionId, prompt: string, images: ContentBlock[] = []): Promise<void> {
    if (this.active) throw new Error('An Antigravity turn is already running');
    this.cancelled = false;
    this.tools.clear();
    this.completedTools.clear();
    this.active = this.runPrompt(prompt, images);
    try { await this.active; } finally { this.active = null; this.options.resetPermissions?.(); }
  }

  private async runPrompt(prompt: string, images: ContentBlock[]): Promise<void> {
    this.emit({ type: 'status', status: 'running' });
    try {
      await this.connect();
      if (images.length && !this.capabilities.promptCapabilities?.image) throw new Error('Antigravity ACP does not support image input');
      await this.configure();
      if (this.cancelled) throw new AgyCancelledError();
      const response = await Promise.race([this.connection!.prompt({
        sessionId: this.sessionId!, prompt: [{ type: 'text', text: this.options.initialPrompt && !this.initialPromptDelivered
          ? `${this.options.initialPrompt}\n\n${prompt}` : prompt }, ...images],
      }), this.lifetime]);
      if (this.cancelled || response.stopReason === 'cancelled') throw new AgyCancelledError();
      if (response.stopReason !== 'end_turn') throw new Error(`Antigravity stopped: ${response.stopReason}`);
      this.initialPromptDelivered = true;
      this.emit({ type: 'status', status: 'idle' });
    } catch (error) {
      if (this.cancelled || error instanceof AgyCancelledError) throw new AgyCancelledError();
      const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Antigravity ACP failed';
      const detail = sanitizeDiagnosticText(message, 2_000);
      this.emit({ type: 'status', status: 'error', detail });
      throw new Error(detail);
    } finally {
      for (const [callId, toolName] of this.tools) this.emit({ type: 'tool-result', callId, toolName, result: 'Tool interrupted before completion.', isError: true });
      this.tools.clear();
    }
  }

  private update({ sessionId, update }: SessionNotification): void {
    if (this.replaying || sessionId !== this.sessionId || !this.active) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.emit({ type: 'model-output', textDelta: update.content.text });
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      this.emit({ type: 'event', name: 'thinking', payload: { text: update.content.text, streaming: true } });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const callId = update.toolCallId;
      if (this.completedTools.has(callId)) return;
      if (!this.tools.has(callId)) {
        const mapped = this.displayTool(update);
        this.tools.set(callId, mapped.toolName);
        this.emit({ type: 'tool-call', callId, ...mapped });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        // Raw outputs may contain entire files/secrets. Happy currently renders lifecycle only.
        this.emit({ type: 'tool-result', callId, toolName: this.tools.get(callId)!, result: update.status === 'failed' ? 'Antigravity tool failed.' : null, isError: update.status === 'failed' });
        this.tools.delete(callId);
        this.completedTools.add(callId);
      }
    }
  }

  private displayTool(update: RequestPermissionRequest['toolCall']) {
    const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : {};
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
    const name = isHappyTitle ? 'mcp__happy__change_title' : typeof input.name === 'string' ? input.name
      : update.kind === 'search' ? searchTool
      : update.kind ? kindTool[update.kind] ?? update.kind : 'agy_tool';
    return mapAgyToolToDisplay(name, parameters);
  }

  private async permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (request.sessionId !== this.sessionId || this.cancelled || this.disposed || !this.active) return cancelled;
    const signal = this.permissionAbort.signal;
    if (signal.aborted) return cancelled;
    let abort: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const bypass = this.mode === 'yolo' || this.mode === 'bypassPermissions';
      const display = this.displayTool(request.toolCall);
      const result = bypass ? { decision: 'approved' as const } : this.options.requestPermission
        ? await Promise.race([this.options.requestPermission(request.toolCall.toolCallId, display.toolName, display.args), aborted])
        : { decision: 'denied' as const };
      if (!result || this.cancelled || signal.aborted || result.decision === 'abort') return cancelled;
      const approved = result.decision === 'approved' || result.decision === 'approved_for_session';
      const option = request.options.find((option) => option.kind === (approved ? 'allow_once' : 'reject_once'));
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
    } catch { return cancelled; }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.cancelled = true;
    this.permissionAbort.abort();
    this.options.resetPermissions?.();
    const active = this.active;
    try {
      if (this.connection && this.sessionId) void this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([active.catch(() => {}), new Promise<void>((resolve) => {
          timer = setTimeout(() => { this.stopProcess(); resolve(); }, this.options.cancelGraceMs ?? 5_000);
        })]);
      } finally { clearTimeout(timer); }
    } finally { this.permissionAbort = new AbortController(); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelled = true;
    this.stopProcess();
    this.handlers.clear();
    await Promise.all(this.terminating);
  }
}
