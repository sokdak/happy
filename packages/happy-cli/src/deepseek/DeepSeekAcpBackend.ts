import { spawn as crossSpawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, type ContentBlock, type SessionConfigOption,
    type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk';
import { DEEPSEEK_MODELS } from '@slopus/happy-wire';
import type { AgentMessage, AgentMessageHandler } from '@/agent/core';
import type { AcpBackendOptions } from '@/agent/acp/AcpBackend';
import type { PermissionResult } from '@/utils/BasePermissionHandler';
import { hashObject } from '@/utils/deterministicJson';
import { deepSeekProfilePatch, normalizeDeepSeekPermissionMode, type DeepSeekPermissionMode,
    type resolveDeepSeekOptions } from './options';

type Launch = ReturnType<typeof resolveDeepSeekOptions>;
type SelectOption = { value: string; name: string; options?: SelectOption[] };
type Tool = { name: string; args: Record<string, unknown> };

function toolName(name: string): string {
    return ({ read: 'Read', read_image: 'Read', write: 'Write', edit: 'Edit',
        pwsh: 'Bash', bash: 'Bash', glob: 'Glob', grep: 'Grep', todo_write: 'TodoWrite',
        subagent: 'Task', subagent_fork: 'Task', web_search: 'WebSearch', web_fetch: 'WebFetch' } as Record<string, string>)[name] ?? name;
}

export class DeepSeekCancelledError extends Error {
    constructor() { super('DeepSeek turn cancelled'); this.name = 'DeepSeekCancelledError'; }
}

function record(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]).finally(() => clearTimeout(timer!));
}

function textContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? '');
    return content.map(item => {
        const block = record(item);
        const body = block.type === 'content' ? record(block.content) : block;
        if (body.type === 'text') return body.text ?? '';
        if (block.type === 'diff') return JSON.stringify(block);
        return JSON.stringify(block);
    }).join('\n');
}

/** Native DSH ACP adapter. Prompt completion, not a stream-idle timer, ends a turn. */
export class DeepSeekAcpBackend {
    private readonly handlers = new Set<AgentMessageHandler>();
    private child: ChildProcess | null = null;
    private connection: ClientSideConnection | null = null;
    private nativeId: string | null;
    private profileDirectory: string | null = null;
    private profileFile: string | null = null;
    private policyFile: string | null = null;
    private generation = 0;
    private disposed = false;
    private prompt: Promise<unknown> | null = null;
    private cancelled = false;
    private mode: DeepSeekPermissionMode;
    private model: string;
    private effort: string;
    private rawOptions: SessionConfigOption[] = [];
    private nativeModels = new Map<string, string>();
    private tools = new Map<string, Tool>();
    private stderr = '';
    private transportFailure: Promise<never> | null = null;
    private rejectTransport: ((error: Error) => void) | null = null;
    private readonly pendingPermissions = new Set<() => void>();
    private recovery: Promise<void> | null = null;
    private readonly sessionApprovals = new Set<string>();

    constructor(private readonly options: AcpBackendOptions, private readonly launch: Launch) {
        this.mode = launch.permissionMode;
        this.model = launch.model;
        this.effort = launch.effort;
        this.nativeId = launch.resumeSessionId ?? null;
    }

    onMessage(handler: AgentMessageHandler) { this.handlers.add(handler); }
    offMessage(handler: AgentMessageHandler) { this.handlers.delete(handler); }
    private emit(message: AgentMessage) { for (const handler of this.handlers) handler(message); }
    private diagnostic(message: string) {
        const key = this.launch.env.DEEPSEEK_API_KEY;
        return (key ? message.split(key).join('[redacted]') : message).slice(-2000);
    }

    async startSession(): Promise<{ sessionId: string }> {
        await this.recovery;
        if (this.disposed) throw new Error('DeepSeek backend is disposed');
        if (this.connection && this.nativeId) return { sessionId: this.nativeId };
        this.emit({ type: 'status', status: 'starting' });
        await this.connect();
        return { sessionId: this.nativeId! };
    }

    private async connect() {
        if (!this.profileDirectory) {
            this.profileDirectory = await mkdtemp(join(tmpdir(), 'happy-deepseek-'));
            this.profileFile = join(this.profileDirectory, 'acp.json');
            this.policyFile = join(this.profileDirectory, 'permissions.mjs');
            // Harness pins permissions in the durable session. Replacing only
            // process defaults cannot override a resumed session's old policy.
            // Use its public preset setter so the new policy is both enforced
            // and recorded through the Harness's canonical session events.
            await writeFile(this.policyFile, `import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const name = 'happy-permissions';
export const inject = ['permissionPresets', 'tools'];
export async function apply(ctx, config) {
  const presets = ctx.permissionPresets;
  ctx.on('agent/created', ({ agent }) => presets.set(agent.session, 'happy'));
  if (config.happy) {
    const require = createRequire(realpathSync(process.argv[1]));
    const mcp = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href);
    await mcp.apply(ctx, mcp.Config(config.happy));
  }
  ctx.provide('happyDeepSeekReady', {});
}
`, { mode: 0o600 });
        }
        const patch: unknown[] = deepSeekProfilePatch(this.model, this.effort, this.mode, this.options.cwd);
        const happy = this.options.mcpServers?.happy;
        // Standard ACP MCP entries hard-code DSH's 60-second call timeout.
        // Questions wait for a person. Mount its configurable client, and wait
        // for tool discovery before allowing ACP to accept a session.
        patch.push({ insert: [{ id: 'happy-permissions', name: this.policyFile, config: {
            ...(happy ? { happy: {
                transport: 'stdio', serverName: 'happy', command: happy.command, args: happy.args ?? [],
                env: happy.env ?? {}, cwd: this.options.cwd, toolCallTimeoutMs: 24 * 60 * 60 * 1000, failOnStartupError: true,
            } } : {}),
        } }] });
        patch.push({ id: 'acp', inject: ['acpAppStartup', 'happyDeepSeekReady'] });
        await writeFile(this.profileFile!, JSON.stringify(patch), { mode: 0o600 });
        const generation = ++this.generation;
        const child = crossSpawn(this.launch.command, [...this.launch.args, '--profile', 'acp', '--patch', this.profileFile!], {
            cwd: this.options.cwd, env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        this.child = child;
        this.stderr = '';
        child.stderr!.on('data', chunk => { this.stderr = this.diagnostic(this.stderr + String(chunk)); });
        let rejectExit!: (error: Error) => void;
        const exited = new Promise<never>((_, reject) => { rejectExit = reject; });
        void exited.catch(() => {});
        this.transportFailure = exited;
        this.rejectTransport = rejectExit;
        const fail = (reason: string) => {
            if (generation !== this.generation || this.disposed) return;
            this.connection = null;
            const message = this.diagnostic(`${reason}${this.stderr ? `: ${this.stderr}` : ''}`);
            rejectExit(new Error(message));
            this.emit({ type: 'status', status: 'stopped', detail: message });
        };
        child.once('error', error => fail(`DeepSeek Harness could not start: ${error.message}`));
        child.once('exit', (code, signal) => fail(`DeepSeek Harness exited (${signal ?? code})`));
        if (!child.stdin || !child.stdout) throw new Error('DeepSeek Harness stdio pipes are unavailable');
        const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
        const connection = new ClientSideConnection(() => ({
            sessionUpdate: async params => { if (generation === this.generation) this.update(params); },
            requestPermission: async params => this.requestPermission(params),
        }), stream);
        this.connection = connection;
        try {
            const initialized = await bounded(Promise.race([connection.initialize({ protocolVersion: 1,
                clientCapabilities: {}, clientInfo: { name: 'happy-cli', version: '1' } }), exited]), 60_000, 'DeepSeek initialize');
            const mcpServers = Object.entries(this.options.mcpServers ?? {}).filter(([name]) => name !== 'happy').map(([name, server]) => ({
                name, command: server.command, args: server.args ?? [],
                env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
            }));
            let response;
            if (this.nativeId) {
                if (!record(initialized.agentCapabilities?.sessionCapabilities).resume) throw new Error('Installed dsh does not advertise ACP session/resume; upgrade DeepSeek Harness.');
                response = await bounded(Promise.race([connection.unstable_resumeSession({
                    sessionId: this.nativeId, cwd: this.options.cwd, mcpServers,
                }), exited]), 60_000, 'DeepSeek session resume');
            } else {
                response = await bounded(Promise.race([connection.newSession({ cwd: this.options.cwd, mcpServers }), exited]), 60_000, 'DeepSeek new session');
                this.nativeId = response.sessionId;
            }
            this.publishConfig(response.configOptions ?? []);
            if (this.nativeModels.size !== DEEPSEEK_MODELS.length) throw new Error('DeepSeek Harness did not advertise both supported API models. Upgrade dsh and check its configuration.');
            this.emit({ type: 'status', status: 'idle' });
        } catch (error) {
            await this.disconnect();
            throw error;
        }
    }

    private publishConfig(options: SessionConfigOption[]) {
        this.rawOptions = options;
        this.nativeModels.clear();
        const projected = options.map(option => {
            if (option.category === 'thought_level') {
                if (option.currentValue) this.effort = option.currentValue;
                return { ...option, currentValue: option.currentValue || this.effort,
                    options: option.options.filter(entry => !('value' in entry) || entry.value !== '') };
            }
            if (option.category !== 'model') return option;
            const flattened: SelectOption[] = [];
            const visit = (entries: readonly any[]) => {
                for (const entry of entries) {
                    if (Array.isArray(entry.options)) { visit(entry.options); continue; }
                    if (typeof entry.value !== 'string') continue;
                    let pair: unknown;
                    try { pair = JSON.parse(entry.value); } catch { continue; }
                    if (!Array.isArray(pair) || pair[0] !== 'deepseek-official') continue;
                    const model = DEEPSEEK_MODELS.find(model => model.id === pair[1]);
                    if (!model) continue;
                    this.nativeModels.set(model.id, entry.value);
                    flattened.push({ value: model.id, name: model.name });
                }
            };
            visit(option.options);
            const current = [...this.nativeModels].find(([, native]) => native === option.currentValue)?.[0];
            if (current) this.model = current;
            return { ...option, currentValue: current ?? this.model, options: flattened };
        });
        const reasoning = options.find(option => option.category === 'thought_level');
        if (reasoning?.currentValue) this.effort = reasoning.currentValue;
        projected.push({ id: 'happy_permission_mode', name: 'Permissions', type: 'select', category: 'mode', currentValue: this.mode,
            options: [ { value: 'auto', name: 'Auto' }, { value: 'safe-yolo', name: 'Workspace' },
                { value: 'read-only', name: 'Read' }, { value: 'yolo', name: 'Yolo' }, { value: 'default', name: 'Default' } ] });
        this.emit({ type: 'event', name: 'config_options_update', payload: { configOptions: projected } });
    }

    private update(params: SessionNotification) {
        const update = record(params.update);
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            this.emit({ type: 'model-output', textDelta: update.content.text });
        } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
            this.emit({ type: 'event', name: 'thinking', payload: { text: update.content.text, streaming: true } });
        } else if (update.sessionUpdate === 'config_option_update') {
            this.publishConfig(update.configOptions ?? []);
        } else if (update.sessionUpdate === 'usage_update') {
            this.emit({ type: 'event', name: 'context_usage', payload: { used: update.used, size: update.size, cost: update.cost } });
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            const id = update.toolCallId;
            if (typeof id !== 'string') return;
            const previous = this.tools.get(id);
            const raw = record(update.rawInput);
            const name = toolName(typeof raw.name === 'string' ? raw.name : previous?.name ?? update.title ?? update.kind ?? 'tool');
            const args = { ...previous?.args, ...(raw.arguments ? record(raw.arguments) : raw) };
            if (!previous || Object.keys(raw).length) {
                this.tools.set(id, { name, args });
                this.emit({ type: 'tool-call', callId: id, toolName: name, args });
            }
            if (update.status === 'completed' || update.status === 'failed') {
                this.emit({ type: 'tool-result', callId: id, toolName: name,
                    result: textContent(update.content ?? update.rawOutput), isError: update.status === 'failed' });
                this.tools.delete(id);
            }
        }
    }

    private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const call = params.toolCall;
        const tool = this.tools.get(call.toolCallId);
        const name = tool?.name ?? toolName(call.title ?? call.kind ?? 'tool');
        const args = tool?.args ?? record(call.rawInput);
        const approvalKey = hashObject({ name, args });
        let abort!: () => void;
        const cancelled = new Promise<PermissionResult>(resolve => { abort = () => resolve({ decision: 'abort' }); });
        this.pendingPermissions.add(abort);
        let result: PermissionResult;
        try {
            result = this.sessionApprovals.has(approvalKey) ? { decision: 'approved' }
                : await Promise.race([cancelled, this.options.permissionHandler?.handleToolCall(call.toolCallId,
                    name, args) ?? Promise.resolve({ decision: 'denied' as const })]);
        } catch {
            return { outcome: { outcome: 'cancelled' } };
        } finally {
            this.pendingPermissions.delete(abort);
        }
        if (result.decision === 'abort') return { outcome: { outcome: 'cancelled' } };
        if (result.decision === 'approved_for_session') this.sessionApprovals.add(approvalKey);
        const allow = result.decision === 'approved' || result.decision === 'approved_for_session';
        const preferred = result.decision === 'approved_for_session' ? 'allow_always' : allow ? 'allow_once' : 'reject_once';
        const option = params.options.find(option => option.kind === preferred)
            ?? params.options.find(option => allow ? option.kind.startsWith('allow_') : option.kind.startsWith('reject_'));
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    }

    async setSessionConfigOption(id: string, value: string): Promise<boolean> {
        await this.recovery;
        if (id === 'happy_permission_mode') {
            const mode = normalizeDeepSeekPermissionMode(value);
            if (mode === this.mode) return true;
            if (this.prompt) throw new Error('Cannot change DeepSeek permissions while a prompt is running');
            this.sessionApprovals.clear();
            await this.disconnect();
            this.mode = mode;
            await this.connect();
            return true;
        }
        if (!this.connection || !this.nativeId) throw new Error('DeepSeek session is not connected');
        const option = this.rawOptions.find(option => option.id === id);
        const nativeValue = option?.category === 'model' ? this.nativeModels.get(value) : value;
        if (nativeValue === undefined) throw new Error(`Unsupported DeepSeek model: ${value}`);
        const response = await this.connection.setSessionConfigOption({ sessionId: this.nativeId, configId: id, value: nativeValue });
        this.publishConfig(response.configOptions);
        return true;
    }
    async setSessionMode(mode: string) { return this.setSessionConfigOption('happy_permission_mode', mode); }
    async setSessionModel(model: string) {
        const option = this.rawOptions.find(option => option.category === 'model');
        return option ? this.setSessionConfigOption(option.id, model) : false;
    }

    async sendPrompt(_sessionId: string, text: string, images: ContentBlock[] = []): Promise<void> {
        await this.recovery;
        if (this.prompt) throw new Error('A DeepSeek prompt is already running');
        if (this.disposed) throw new Error('DeepSeek backend is disposed');
        if (!this.connection) await this.connect();
        if (!this.connection || !this.nativeId) throw new Error('DeepSeek session is not connected');
        if (images.length && this.model !== 'deepseek-flash') throw new Error('DeepSeek V4 Pro does not support image input. Select DeepSeek Flash.');
        this.cancelled = false;
        this.emit({ type: 'status', status: 'running' });
        this.prompt = Promise.race([this.connection.prompt({ sessionId: this.nativeId,
            prompt: [...(text ? [{ type: 'text' as const, text }] : []), ...images] }), this.transportFailure!]);
        try {
            const response = await this.prompt as { stopReason: string };
            if (this.cancelled || response.stopReason === 'cancelled') throw new DeepSeekCancelledError();
            if (response.stopReason === 'refusal') throw new Error('DeepSeek refused this request');
            if (response.stopReason === 'max_tokens') throw new Error('DeepSeek reached the output token limit');
        } catch (error) {
            if (this.cancelled) throw new DeepSeekCancelledError();
            throw error;
        } finally {
            this.prompt = null;
            this.tools.clear();
        }
    }

    async cancel(_sessionId?: string) {
        this.cancelled = true;
        for (const abort of this.pendingPermissions) abort();
        if (this.connection && this.nativeId && this.prompt) {
            try {
                await bounded(this.connection.cancel({ sessionId: this.nativeId }).then(() => this.prompt?.catch(() => {})), 10_000, 'DeepSeek cancellation');
            } catch {
                // A wedged turn must not block the queue. The next prompt resumes
                // this same native session in a fresh Harness process.
                this.recovery = this.disconnect();
                await this.recovery;
                this.recovery = null;
            }
        }
    }

    private async disconnect() {
        ++this.generation;
        for (const abort of this.pendingPermissions) abort();
        const child = this.child;
        this.child = null;
        this.connection = null;
        this.rejectTransport?.(new Error('DeepSeek connection closed'));
        this.rejectTransport = null;
        this.transportFailure = null;
        if (!child) return;
        const exited = new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', () => resolve());
        });
        child.stdin?.end();
        try { await bounded(exited, 3000, 'DeepSeek shutdown'); } catch {
            if (process.platform === 'win32' && child.pid) {
                crossSpawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } else child.kill('SIGTERM');
            await bounded(exited, 3000, 'DeepSeek process exit').catch(() => {});
        }
    }

    async dispose() {
        this.disposed = true;
        await this.cancel().catch(() => {});
        await this.recovery;
        await this.disconnect();
        if (this.profileFile) await unlink(this.profileFile).catch(() => {});
        if (this.policyFile) await unlink(this.policyFile).catch(() => {});
        if (this.profileDirectory) await rmdir(this.profileDirectory).catch(() => {});
    }
}
