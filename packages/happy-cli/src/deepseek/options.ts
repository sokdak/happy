import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_EFFORT_LEVELS, DEEPSEEK_MODELS } from '@slopus/happy-wire';
import { configuration } from '@/configuration';

export const DEEPSEEK_PERMISSION_MODES = ['auto', 'default', 'read-only', 'safe-yolo', 'yolo'] as const;
export type DeepSeekPermissionMode = typeof DEEPSEEK_PERMISSION_MODES[number];

export interface DeepSeekStartOptions {
    model?: string;
    effort?: string;
    permissionMode?: string;
    resumeSessionId?: string;
    startedBy?: 'daemon' | 'terminal';
    verbose?: boolean;
}

function executable(path: string): boolean {
    try {
        const script = ['.js', '.cjs', '.mjs'].includes(extname(path));
        accessSync(path, script ? constants.R_OK : process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return statSync(path).isFile();
    } catch { return false; }
}

/** Resolve the installed Harness independently of the Claude installation. */
export function findDeepSeekCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.HAPPY_DEEPSEEK_PATH) {
        const path = resolve(env.HAPPY_DEEPSEEK_PATH);
        return executable(path) ? path : undefined;
    }
    const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
    for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) {
            const path = join(directory.replace(/^"|"$/g, ''), name);
            if (executable(path)) return path;
        }
    }
    return undefined;
}

export function normalizeDeepSeekPermissionMode(mode = 'yolo'): DeepSeekPermissionMode {
    // Preserve picks saved before Happy switched DeepSeek to its own Harness.
    if (mode === 'bypassPermissions') return 'yolo';
    if (mode === 'acceptEdits') return 'auto';
    if (mode === 'plan') return 'read-only';
    if (!(DEEPSEEK_PERMISSION_MODES as readonly string[]).includes(mode)) throw new Error(`Unsupported DeepSeek permission mode: ${mode}`);
    return mode as DeepSeekPermissionMode;
}

export function deepSeekExecutionPolicy(mode: DeepSeekPermissionMode) {
    return {
        sandbox: mode === 'yolo' ? 'danger-full-access' : mode === 'read-only' ? 'read-only' : 'workspace-write',
        approval: mode === 'yolo' || mode === 'safe-yolo' || mode === 'read-only' ? 'never' : 'ask',
    } as const;
}

export function supportsDeepSeekNode(nodeVersion = process.versions.node): boolean {
    const [major, minor] = nodeVersion.split('.').map(Number);
    return major > 24 || (major === 24 && minor >= 9);
}

export function resolveDeepSeekOptions(options: DeepSeekStartOptions = {}, env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node) {
    if (!supportsDeepSeekNode(nodeVersion)) throw new Error('DeepSeek Harness requires Node.js 24.9 or newer.');
    const path = findDeepSeekCli(env);
    if (!path) throw new Error('DeepSeek Harness CLI was not found. Install @deepseek-ai/dsh (tested: 0.2.2-rc.1), or set HAPPY_DEEPSEEK_PATH to its executable.');
    const apiKey = env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error('DeepSeek requires DEEPSEEK_API_KEY on the machine running Happy. Set it before starting the daemon or running happy deepseek.');
    const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    if (!DEEPSEEK_MODELS.some(candidate => candidate.id === model)) throw new Error(`Unsupported DeepSeek model: ${model}`);
    const effort = options.effort ?? 'high';
    if (!(DEEPSEEK_EFFORT_LEVELS as readonly string[]).includes(effort)) throw new Error(`Unsupported DeepSeek effort: ${effort}`);
    if (options.resumeSessionId !== undefined && !options.resumeSessionId.trim()) throw new Error('DeepSeek resume requires an explicit Harness session ID.');
    const childEnv: NodeJS.ProcessEnv = { ...env, DEEPSEEK_API_KEY: apiKey,
        DSH_HOME: resolve(env.HAPPY_DEEPSEEK_HOME ?? join(configuration.happyHomeDir, 'deepseek')) };
    for (const key of Object.keys(childEnv)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete childEnv[key];
    }
    const isJs = ['.js', '.cjs', '.mjs'].includes(extname(path));
    return { ...options, model, effort, permissionMode: normalizeDeepSeekPermissionMode(options.permissionMode),
        command: isJs ? process.execPath : path, args: isJs ? [path] : [], env: childEnv };
}

/** The overlay contains credential references, never API-key contents. */
export function deepSeekProfilePatch(model: string, effort: string, mode: DeepSeekPermissionMode, cwd: string) {
    const policy = deepSeekExecutionPolicy(mode);
    return [
        { id: 'acp', config: { provider: 'deepseek-official', model } },
        { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
        { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', reasoningEffort: effort,
            models: DEEPSEEK_MODELS.map(candidate => ({ id: candidate.id, name: candidate.name,
                contextWindow: candidate.contextWindow, inputModalities: candidate.id === 'deepseek-flash' ? ['text', 'image'] : ['text'] })) } },
        { id: 'llm-deepseek-account', disabled: true },
        { id: 'sandbox-policy', config: { mode: policy.sandbox, workspaceRoot: resolve(cwd) } },
        { id: 'approval', config: { policy: policy.approval } },
        { id: 'permission', config: { defaultPreset: 'happy', presets: { happy: { sandbox: policy.sandbox, approval: policy.approval } } } },
        { id: 'otel', disabled: true },
    ];
}
