import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@/agent/core';
import { DeepSeekAcpBackend } from './DeepSeekAcpBackend';
import { resolveDeepSeekOptions } from './options';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';

// Runs the published Harness against a local Messages API fixture. No live key
// or inference is needed. Point HAPPY_TEST_DEEPSEEK_PATH at dsh's lib/bin.js.
describe.skipIf(!process.env.HAPPY_TEST_DEEPSEEK_PATH)('published DeepSeek Harness ACP', () => {
    let directory: string;
    let workspace: string;
    let backend: DeepSeekAcpBackend;
    let events: AgentMessage[];
    let requests: any[];
    let uploads: Buffer[];
    let reply: (body: any, response: ServerResponse) => void;
    let server: ReturnType<typeof createServer>;
    let permission: ReturnType<typeof vi.fn>;
    let launch: ReturnType<typeof resolveDeepSeekOptions>;
    let stopMcp: (() => void) | undefined;

    function stream(response: ServerResponse, body: any, tool?: { name: string; input: unknown }) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type: string, fields: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: body.model,
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 123, output_tokens: 0 } } });
        send('content_block_start', { index: 0, content_block: tool
            ? { type: 'tool_use', id: `tool-${requests.length}`, name: tool.name, input: {} }
            : { type: 'text', text: '' } });
        if (tool) send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
        else {
            send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello\n\n' } });
            send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '**world**' } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        send('message_stop', {});
        response.end();
    }

    function nextTool(name: string, input: unknown) {
        let first = true;
        reply = (body, response) => {
            const tool = first ? { name, input } : undefined;
            first = false;
            stream(response, body, tool);
        };
    }

    beforeEach(async () => {
        // Keep the external-write fixture outside platform temp roots, which
        // Harness intentionally allows in workspace-write mode.
        directory = await mkdtemp(join(process.cwd(), '.deepseek-acp-test-'));
        workspace = join(directory, 'workspace with spaces');
        await mkdir(workspace);
        events = [];
        requests = [];
        uploads = [];
        permission = vi.fn(async () => ({ decision: 'approved' as const }));
        reply = (body, response) => stream(response, body);
        server = createServer(async (request, response) => {
            if (request.method === 'GET') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const bytes = Buffer.concat(chunks);
            if (request.headers['content-type']?.startsWith('multipart/form-data')) {
                uploads.push(bytes);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ id: 'fixture-image', type: 'file', mime_type: 'image/png', size_bytes: 68,
                    filename: 'image.png', created_at: new Date().toISOString() }));
                return;
            }
            const body = JSON.parse(bytes.toString());
            requests.push(body);
            try { reply(body, response); } catch (error) {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: String(error) } }));
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        launch = resolveDeepSeekOptions({}, { ...process.env,
            HAPPY_DEEPSEEK_PATH: process.env.HAPPY_TEST_DEEPSEEK_PATH,
            HAPPY_DEEPSEEK_HOME: join(directory, 'harness home'),
            DEEPSEEK_API_KEY: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/anthropic`,
        });
        backend = new DeepSeekAcpBackend({ agentName: 'deepseek', command: launch.command, cwd: workspace,
            permissionHandler: { handleToolCall: permission } }, launch);
        backend.onMessage(message => events.push(message));
    });

    afterEach(async () => {
        await backend?.dispose();
        stopMcp?.();
        stopMcp = undefined;
        server?.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    });

    it('uses native model/effort controls and preserves Markdown and context usage', async () => {
        const { sessionId } = await backend.startSession();
        await backend.setSessionModel('deepseek-v4-pro');
        await backend.setSessionConfigOption('reasoning_effort', 'max');
        await backend.sendPrompt(sessionId, 'hello');
        expect(requests[0]).toMatchObject({ model: 'deepseek-v4-pro', output_config: { effort: 'max' } });
        expect(events.filter(event => event.type === 'model-output').map(event => event.textDelta).join('')).toBe('Hello\n\n**world**');
        expect(events).toContainEqual(expect.objectContaining({ type: 'event', name: 'context_usage', payload: expect.objectContaining({ size: 1048576 }) }));
        await backend.setSessionConfigOption('reasoning_effort', 'off');
        await backend.sendPrompt(sessionId, 'no reasoning');
        expect(requests.at(-1).thinking).toEqual({ type: 'disabled' });
        nextTool('skill', { name: 'missing-fixture-skill' });
        await backend.sendPrompt(sessionId, 'try a named skill');
        expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'skill', args: { name: 'missing-fixture-skill' } }));
    }, 60_000);

    it('changes the real sandbox and resumes the same conversation with its selections', async () => {
        const { sessionId } = await backend.startSession();
        const file = join(workspace, 'example.txt');
        nextTool('write', { file_path: file, content: 'before' });
        await backend.sendPrompt(sessionId, 'write a file');
        expect(await readFile(file, 'utf8')).toBe('before');
        expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'Write', args: expect.objectContaining({ file_path: file }) }));
        await backend.setSessionModel('deepseek-v4-pro');
        await backend.setSessionConfigOption('reasoning_effort', 'max');
        await backend.setSessionMode('read-only');
        nextTool('write', { file_path: file, content: 'forbidden' });
        await backend.sendPrompt(sessionId, 'try another write');
        expect(await readFile(file, 'utf8')).toBe('before');
        expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', toolName: 'Write', isError: true }));
        expect(requests.at(-1)).toMatchObject({ model: 'deepseek-v4-pro', output_config: { effort: 'max' } });
        const messages = JSON.stringify(requests.at(-1).messages);
        expect(messages).toContain('write a file');
        expect(messages).toContain('try another write');
        expect((await backend.startSession()).sessionId).toBe(sessionId);
    }, 60_000);

    it.each(['approved', 'denied'] as const)('honors native %s permission outcomes using the actual tool call', async decision => {
        await backend.startSession();
        await backend.setSessionMode('auto');
        permission.mockResolvedValue({ decision } as any);
        const file = join(directory, 'outside-workspace.txt');
        nextTool('write', { file_path: file, content: 'approved write', sandbox_permissions: 'danger-full-access', justification: 'Write the requested fixture' });
        await backend.sendPrompt('', 'write outside the workspace');
        expect(permission).toHaveBeenCalledWith(expect.any(String), 'Write', expect.objectContaining({ file_path: file }));
        if (decision === 'approved') expect(await readFile(file, 'utf8')).toBe('approved write');
        else await expect(readFile(file)).rejects.toThrow();
    }, 60_000);

    it('cancels an in-flight request and accepts the next prompt', async () => {
        await backend.startSession();
        reply = () => {}; // Keep the model request open until ACP cancellation.
        const pending = backend.sendPrompt('', 'wait');
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'DeepSeekCancelledError' });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        await backend.cancel();
        await cancelled;
        reply = (body, response) => stream(response, body);
        await backend.sendPrompt('', 'continue');
        expect(requests).toHaveLength(2);
        expect(events).toContainEqual({ type: 'model-output', textDelta: 'Hello\n\n**world**' });
    }, 60_000);

    it('remembers an exact approval for the session and clears it when permissions change', async () => {
        await backend.startSession();
        await backend.setSessionMode('auto');
        permission.mockResolvedValue({ decision: 'approved_for_session' } as any);
        const input = { file_path: join(directory, 'remembered.txt'), content: 'approved',
            sandbox_permissions: 'danger-full-access', justification: 'Repeat this exact requested operation' };
        for (let index = 0; index < 2; index++) {
            nextTool('write', input);
            await backend.sendPrompt('', 'repeat');
        }
        expect(permission).toHaveBeenCalledTimes(1);
        await backend.setSessionMode('read-only');
        await backend.setSessionMode('auto');
        nextTool('write', input);
        await backend.sendPrompt('', 'ask again');
        expect(permission).toHaveBeenCalledTimes(2);
    }, 60_000);

    it('cancels while a native permission request is still awaiting an answer', async () => {
        await backend.startSession();
        await backend.setSessionMode('auto');
        permission.mockImplementation(() => new Promise(() => {}));
        nextTool('write', { file_path: join(directory, 'pending.txt'), content: 'cancelled',
            sandbox_permissions: 'danger-full-access', justification: 'Test cancellation' });
        const pending = backend.sendPrompt('', 'ask and wait');
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'DeepSeekCancelledError' });
        await vi.waitFor(() => expect(permission).toHaveBeenCalled(), { timeout: 10_000 });
        await backend.cancel();
        await cancelled;
        reply = (body, response) => stream(response, body);
        await backend.sendPrompt('', 'continue');
        await expect(readFile(join(directory, 'pending.txt'))).rejects.toThrow();
    }, 60_000);

    it('recovers after an API error without creating a new session', async () => {
        await backend.startSession();
        reply = (_body, response) => {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture rejected' } }));
        };
        await expect(backend.sendPrompt('', 'fail')).rejects.toThrow();
        reply = (body, response) => stream(response, body);
        await backend.sendPrompt('', 'retry');
        expect(requests).toHaveLength(2);
    }, 60_000);

    it('exposes Happy question and plan tools to the native model through MCP', async () => {
        const requestUserInput = vi.fn(async () => ({ answers: { choice: { answers: ['A'] } } }));
        const updatePlan = vi.fn(async () => ({ success: true }));
        const mcp = await startHappyServer({ sessionId: 'fixture', sendClaudeSessionMessage: () => {} } as any,
            { requestUserInput, updatePlan });
        stopMcp = mcp.stop;
        await backend.dispose();
        backend = new DeepSeekAcpBackend({ agentName: 'deepseek', command: launch.command, cwd: workspace,
            mcpServers: { happy: { command: process.execPath, args: [join(projectPath(), 'bin', 'happy-mcp.mjs'), '--url', mcp.url, '--interactions'] } } }, launch);
        await backend.startSession();
        for (const [name, input] of [
            ['request_user_input', { questions: [{ id: 'choice', header: 'Pick', question: 'Choose A', options: [{ label: 'A', description: 'First' }] }] }],
            ['update_plan', { plan: [{ step: 'Verify ACP', status: 'completed' }] }],
        ] as const) {
            let first = true;
            reply = (body, response) => {
                const tool = body.tools.find((tool: any) => tool.name.includes(name));
                expect(tool).toBeDefined();
                stream(response, body, first ? { name: tool.name, input } : undefined);
                first = false;
            };
            await backend.sendPrompt('', `Use ${name}`);
        }
        expect(requestUserInput).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'choice' })]), expect.any(AbortSignal));
        expect(updatePlan).toHaveBeenCalledWith([{ step: 'Verify ACP', status: 'completed' }]);
        const results = requests.flatMap(body => body.messages).flatMap(message => message.content)
            .filter(block => block.type === 'tool_result');
        const resultText = results.flatMap(block => typeof block.content === 'string' ? [block.content]
            : (block.content ?? []).map((part: any) => part.text ?? ''));
        expect(resultText.some(text => text.includes('"answers":["A"]'))).toBe(true);
    }, 60_000);

    it('forwards image-only Flash prompts and rejects Pro images before inference', async () => {
        await backend.startSession();
        const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
        await backend.sendPrompt('', '', [image]);
        expect(uploads).toHaveLength(1);
        // The native provider may resize/re-encode the admitted image.
        expect(uploads[0].toString('latin1')).toContain('image/');
        const imageBlock = requests[0].messages.flatMap((message: any) => message.content).find((block: any) => block.type === 'image');
        expect(imageBlock).toMatchObject({ source: { type: 'base64', media_type: 'image/webp', data: expect.any(String) } });
        await backend.setSessionModel('deepseek-v4-pro');
        await expect(backend.sendPrompt('', '', [image])).rejects.toThrow('does not support image');
        expect(requests).toHaveLength(1);
    }, 60_000);
});

describe('DeepSeek process failures', () => {
    it('reports startup failure with the API key redacted and disposes safely', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happy-dsh-failure-'));
        const entry = join(directory, 'failed cli.cjs');
        await writeFile(entry, 'process.stderr.write(process.env.DEEPSEEK_API_KEY); process.exit(7);');
        const launch = resolveDeepSeekOptions({}, { HAPPY_DEEPSEEK_PATH: entry, DEEPSEEK_API_KEY: 'private-fixture-key' }, '24.15.0');
        const backend = new DeepSeekAcpBackend({ agentName: 'deepseek', command: launch.command, cwd: directory }, launch);
        try {
            const error = await backend.startSession().catch(error => error as Error);
            expect(error).toBeInstanceOf(Error);
            expect(String(error)).toContain('[redacted]');
            expect(String(error)).not.toContain('private-fixture-key');
        } finally {
            await backend.dispose();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
