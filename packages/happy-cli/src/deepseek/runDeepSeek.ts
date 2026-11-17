import type { Credentials } from '@/persistence';
import type { AgentState, Metadata, Session } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { runAcp } from '@/agent/acp/runAcp';
import { DeepSeekAcpBackend } from './DeepSeekAcpBackend';
import { normalizeDeepSeekPermissionMode, resolveDeepSeekOptions, type DeepSeekStartOptions } from './options';

export function parseDeepSeekArgs(args: string[]): DeepSeekStartOptions & { help: boolean } {
    const options: DeepSeekStartOptions & { help: boolean } = { help: false };
    const value = (index: number, flag: string) => {
        const result = args[index];
        if (!result || result.startsWith('--')) throw new Error(`${flag} requires a value`);
        return result;
    };
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        switch (flag) {
            case '-h': case '--help': options.help = true; break;
            case '--model': options.model = value(++index, flag); break;
            case '--effort': options.effort = value(++index, flag); break;
            case '--permission-mode': options.permissionMode = value(++index, flag); break;
            case '--resume': options.resumeSessionId = value(++index, flag); break;
            case '--verbose': options.verbose = true; break;
            case '--yolo': options.permissionMode = 'yolo'; break;
            case '--started-by': {
                const source = value(++index, flag);
                if (source !== 'daemon' && source !== 'terminal') throw new Error('Invalid --started-by value');
                options.startedBy = source;
                break;
            }
            case '--happy-starting-mode': {
                if (value(++index, flag) !== 'remote') throw new Error('DeepSeek uses ACP remote control; use --happy-starting-mode remote');
                break;
            }
            default: throw new Error(`Unknown DeepSeek option: ${flag}`);
        }
    }
    return options;
}

export function deepSeekReconnectSession(metadata: Metadata, state: AgentState, nativeId: string | undefined, env = process.env): Session | null {
    const keys = ['SESSION_ID', 'ENCRYPTION_KEY', 'ENCRYPTION_VARIANT', 'SEQ', 'METADATA_VERSION', 'AGENT_STATE_VERSION'] as const;
    if (!keys.some(key => env[`HAPPY_RECONNECT_${key}`] !== undefined)) return null;
    const values = keys.map(key => env[`HAPPY_RECONNECT_${key}`]);
    if (values.some(value => !value) || !nativeId?.trim()) throw new Error('DeepSeek resume requires a complete Happy reconnect identity and an explicit Harness session ID');
    const [id, key, variant, seq, metadataVersion, agentStateVersion] = values as string[];
    const numbers = [seq, metadataVersion, agentStateVersion].map(Number);
    const encryptionKey = decodeBase64(key);
    if ((variant !== 'legacy' && variant !== 'dataKey') || numbers.some(n => !Number.isSafeInteger(n) || n < 0) || encryptionKey.length !== 32) {
        throw new Error('Invalid Happy reconnect identity');
    }
    let saved: Metadata;
    try {
        saved = JSON.parse(env.HAPPY_DEEPSEEK_RECONNECT_METADATA ?? 'null');
        if (!saved || saved.flavor !== 'deepseek' || saved.deepseekSessionId !== nativeId
            || saved.path !== metadata.path || saved.machineId !== metadata.machineId) throw new Error();
    } catch { throw new Error('Missing or mismatched DeepSeek reconnect metadata'); }
    return { id, encryptionKey, encryptionVariant: variant, seq: numbers[0], metadataVersion: numbers[1],
        agentStateVersion: numbers[2], metadata: { ...saved, ...metadata }, agentState: state };
}

export async function runDeepSeek(credentials: Credentials, options: DeepSeekStartOptions = {}): Promise<void> {
    const launch = resolveDeepSeekOptions(options);
    await runAcp({
        credentials, agentName: 'deepseek', command: launch.command, args: launch.args,
        startedBy: options.startedBy, verbose: options.verbose,
        model: options.resumeSessionId ? options.model : launch.model,
        effort: options.resumeSessionId ? options.effort : launch.effort,
        permissionMode: launch.permissionMode, defaultModel: launch.model, defaultEffort: 'high',
        backendFactory: backendOptions => new DeepSeekAcpBackend(backendOptions, launch),
        nativeSessionIdKey: 'deepseekSessionId',
        reconnect: (metadata, state) => deepSeekReconnectSession(metadata, state, options.resumeSessionId),
        interactionTools: true,
        normalizePermissionMode: normalizeDeepSeekPermissionMode,
        responseCompletesTurn: true, recoverPromptErrors: true, preserveSessionOnExit: true,
        interactive: options.startedBy !== 'daemon',
    });
}
