import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepSeekExecutionPolicy, deepSeekProfilePatch, resolveDeepSeekOptions } from './options';
import { deepSeekReconnectSession, parseDeepSeekArgs } from './runDeepSeek';
import { encodeBase64 } from '@/api/encryption';

describe('DeepSeek native Harness configuration', () => {
    let directory: string;
    let path: string;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happy-dsh-test-'));
        path = join(directory, 'dsh.mjs');
        await writeFile(path, '// fake executable', { mode: 0o700 });
    });
    afterAll(async () => { await rm(path); await rmdir(directory); });
    const env = () => ({ HAPPY_DEEPSEEK_PATH: path, DEEPSEEK_API_KEY: 'test-key' });

    it('uses dsh without inheriting Claude credentials or profile state', () => {
        const original = { ...env(), ANTHROPIC_API_KEY: 'claude-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/claude' };
        const options = resolveDeepSeekOptions({}, original, '24.15.0');
        expect(options).toMatchObject({ command: process.execPath, args: [path], model: 'deepseek-flash', effort: 'high', permissionMode: 'yolo' });
        expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
        expect(options.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(options.env.DSH_HOME).toContain('deepseek');
        expect(original.ANTHROPIC_API_KEY).toBe('claude-key');
    });

    it.each(['20.19.0', '24.8.0'])('rejects unsupported Node %s before launch', version => {
        expect(() => resolveDeepSeekOptions({}, env(), version)).toThrow('24.9');
    });
    it('requires an installed Harness and its own API key', () => {
        expect(() => resolveDeepSeekOptions({}, { ...env(), HAPPY_DEEPSEEK_PATH: join(directory, 'missing') }, '24.15.0')).toThrow('CLI was not found');
        expect(() => resolveDeepSeekOptions({}, { ...env(), DEEPSEEK_API_KEY: '' }, '24.15.0')).toThrow('DEEPSEEK_API_KEY');
    });
    it('keeps current model ids and native effort values', () => {
        expect(resolveDeepSeekOptions({ model: 'deepseek-v4-pro', effort: 'off' }, env(), '24.15.0')).toMatchObject({ model: 'deepseek-v4-pro', effort: 'off' });
        expect(() => resolveDeepSeekOptions({ model: 'deepseek-chat' }, env(), '24.15.0')).toThrow('Unsupported DeepSeek model');
        expect(() => resolveDeepSeekOptions({ effort: 'medium' }, env(), '24.15.0')).toThrow('Unsupported DeepSeek effort');
    });
    it('maps Codex-style permissions to real Harness sandbox policies', () => {
        expect(deepSeekExecutionPolicy('yolo')).toEqual({ sandbox: 'danger-full-access', approval: 'never' });
        expect(deepSeekExecutionPolicy('safe-yolo')).toEqual({ sandbox: 'workspace-write', approval: 'never' });
        expect(deepSeekExecutionPolicy('read-only')).toEqual({ sandbox: 'read-only', approval: 'never' });
        expect(deepSeekExecutionPolicy('auto')).toEqual({ sandbox: 'workspace-write', approval: 'ask' });
        expect(resolveDeepSeekOptions({ permissionMode: 'bypassPermissions' }, env(), '24.15.0').permissionMode).toBe('yolo');
    });
    it('writes key references and exact models into the overlay', () => {
        const patch = deepSeekProfilePatch('deepseek-v4-pro', 'max', 'read-only', directory);
        const text = JSON.stringify(patch);
        expect(text).toContain('DEEPSEEK_API_KEY');
        expect(text).not.toContain('test-key');
        expect(text).not.toContain('claude');
        expect(patch.find(entry => entry.id === 'acp')?.config).toMatchObject({ model: 'deepseek-v4-pro' });
    });
    it('parses native resume and effort options without forwarding Claude flags', () => {
        expect(parseDeepSeekArgs(['--resume', 'native-id', '--model', 'deepseek-v4-pro', '--effort', 'max', '--permission-mode', 'read-only']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'deepseek-v4-pro', effort: 'max', permissionMode: 'read-only' });
        expect(() => parseDeepSeekArgs(['--claude-env', 'ANY=value'])).toThrow('Unknown DeepSeek option');
    });

    it('reuses a complete encrypted Happy identity only for its own machine, path and native session', () => {
        const metadata = { path: '/repo', host: 'host', machineId: 'machine', flavor: 'deepseek', deepseekSessionId: 'dsh-id',
            homeDir: '/home', happyHomeDir: '/home/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' };
        const env = { HAPPY_RECONNECT_SESSION_ID: 'saved-happy', HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(new Uint8Array(32)),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey', HAPPY_RECONNECT_SEQ: '12', HAPPY_RECONNECT_METADATA_VERSION: '3',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '4', HAPPY_DEEPSEEK_RECONNECT_METADATA: JSON.stringify(metadata) };
        expect(deepSeekReconnectSession(metadata, {}, 'dsh-id', env)).toMatchObject({ id: 'saved-happy', seq: 12, encryptionVariant: 'dataKey', metadata: { deepseekSessionId: 'dsh-id' } });
        expect(deepSeekReconnectSession(metadata, {}, undefined, {})).toBeNull();
        expect(() => deepSeekReconnectSession(metadata, {}, 'dsh-id', { HAPPY_RECONNECT_SESSION_ID: 'partial' })).toThrow('complete Happy reconnect identity');
        expect(() => deepSeekReconnectSession({ ...metadata, path: '/elsewhere' }, {}, 'dsh-id', env)).toThrow('mismatched');
        expect(() => deepSeekReconnectSession(metadata, {}, 'another-native-id', env)).toThrow('mismatched');
        expect(() => deepSeekReconnectSession(metadata, {}, 'dsh-id', { ...env, HAPPY_RECONNECT_SEQ: '-1' })).toThrow('Invalid Happy reconnect identity');
    });
});
