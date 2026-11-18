/**
 * Primary DeepSeek acceptance tests: installed dsh and authenticated live API.
 * Opt in with HAPPY_RUN_DEEPSEEK_INTEGRATION=1 and DEEPSEEK_API_KEY.
 * DeepSeekAcpBackend.test.ts separately tests protocol failures deterministically
 * against the published CLI and a local HTTP fixture; those are support checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@/agent/core';
import { DeepSeekAcpBackend } from './DeepSeekAcpBackend';
import { resolveDeepSeekOptions, type DeepSeekStartOptions } from './options';

describe.skipIf(process.env.HAPPY_RUN_DEEPSEEK_INTEGRATION !== '1')('DeepSeek native acceptance', () => {
    let directory: string;
    let workspace: string;
    let backend: DeepSeekAcpBackend;
    let events: AgentMessage[];
    let decision: 'approved' | 'denied';
    let approvals: number;

    function create(options: DeepSeekStartOptions = {}) {
        const launch = resolveDeepSeekOptions(options, { ...process.env, HAPPY_DEEPSEEK_HOME: join(directory, 'home') });
        backend = new DeepSeekAcpBackend({ agentName: 'deepseek', command: launch.command, cwd: workspace,
            permissionHandler: { handleToolCall: async () => { approvals++; return { decision }; } } }, launch);
        backend.onMessage(message => events.push(message));
    }
    const output = () => events.filter(event => event.type === 'model-output').map(event => event.textDelta).join('');

    beforeEach(async () => {
        directory = await mkdtemp(join(process.cwd(), '.deepseek-live-'));
        workspace = join(directory, 'workspace');
        await mkdir(workspace);
        events = [];
        approvals = 0;
        decision = 'approved';
        create();
    });
    afterEach(async () => {
        await backend?.dispose();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('retains multi-turn context and selections across native session resume', async () => {
        const { sessionId } = await backend.startSession();
        const marker = `happy-${randomUUID()}`;
        await backend.sendPrompt(sessionId, `Remember this marker for our next turn: ${marker}. Reply with OK only.`);
        await backend.setSessionModel('deepseek-v4-pro');
        await backend.setSessionConfigOption('reasoning_effort', 'off');
        await backend.dispose();
        create({ resumeSessionId: sessionId });
        expect((await backend.startSession()).sessionId).toBe(sessionId);
        const config = events.filter(event => event.type === 'event' && event.name === 'config_options_update').at(-1);
        expect(config).toMatchObject({ payload: { configOptions: expect.arrayContaining([
            expect.objectContaining({ category: 'model', currentValue: 'deepseek-v4-pro' }),
            expect.objectContaining({ category: 'thought_level', currentValue: 'off' }),
        ]) } });
        events = [];
        await backend.sendPrompt(sessionId, 'What marker did I ask you to remember? Return it verbatim, without using tools.');
        expect(output()).toContain(marker);
        expect(events.some(event => event.type === 'event' && event.name === 'context_usage')).toBe(true);
    }, 180_000);

    it('enforces read-only and routes genuine escalation approvals and rejections', async () => {
        await backend.startSession();
        const file = join(workspace, 'read-only.txt');
        await backend.setSessionMode('read-only');
        await backend.sendPrompt('', `Use the write tool exactly once to write "blocked" to ${JSON.stringify(file)}. Do not set sandbox_permissions. Report the result, do not retry or use another tool.`);
        await expect(readFile(file)).rejects.toThrow();
        expect(events.some(event => event.type === 'tool-result' && event.isError)).toBe(true);
        await backend.setSessionMode('auto');
        for (const next of ['denied', 'approved'] as const) {
            decision = next;
            const outside = join(directory, `${next}.txt`);
            const before = approvals;
            await backend.sendPrompt('', `Use the write tool once to write "fixture" to ${JSON.stringify(outside)} with sandbox_permissions="danger-full-access" and justification="Write the requested acceptance fixture". Report its result. Do not retry or use other tools.`);
            expect(approvals).toBeGreaterThan(before);
            if (next === 'approved') expect(await readFile(outside, 'utf8')).toBe('fixture');
            else await expect(readFile(outside)).rejects.toThrow();
        }
    }, 240_000);

    it('interrupts a real tool, recovers for the next turn, and stops cleanly', async () => {
        await backend.startSession();
        const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 120' : 'sleep 120';
        const pending = backend.sendPrompt('', `Run ${JSON.stringify(command)} with the ${process.platform === 'win32' ? 'pwsh' : 'bash'} tool in the foreground. Wait for it to finish.`);
        const settled = expect(pending).rejects.toMatchObject({ name: 'DeepSeekCancelledError' });
        await vi.waitFor(() => expect(events.some(event => event.type === 'tool-call' && event.toolName === 'Bash')).toBe(true), { timeout: 90_000 });
        await backend.cancel();
        await settled;
        await expect(backend.setSessionModel('unsupported-model')).rejects.toThrow('Unsupported DeepSeek model');
        events = [];
        await backend.sendPrompt('', 'Reply with RECOVERED only. Do not use tools.');
        expect(output()).toContain('RECOVERED');
        await backend.dispose();
        await expect(backend.sendPrompt('', 'after shutdown')).rejects.toThrow('disposed');
    }, 180_000);
});
