/** Real Codex + Happy HTTP/stdio MCP + a local Responses fixture; no model calls. */
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { CodexAppServerClient } from './codexAppServerClient';
import { buildCodexTurnPrompt } from './codexPrompt';
import { startCodexHappyServer } from './startCodexHappyServer';
import { CodexUserInputHandler } from './utils/userInputHandler';
import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

function codexAvailable(): boolean {
    try {
        const output = process.platform === 'win32'
            ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'codex --version'], { encoding: 'utf8', windowsHide: true })
            : execFileSync('codex', ['--version'], { encoding: 'utf8' });
        const match = output.match(/codex-cli (\d+)\.(\d+)/);
        return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 159);
    } catch { return false; }
}

function complete(response: ServerResponse, item: Record<string, unknown>) {
    for (const event of [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'fixture_response', status: 'completed', output: [item],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Happy question fixture timed out')), 20000);
        })]);
    } finally { clearTimeout(timer); }
}

describe.skipIf(!codexAvailable())('Happy intermediate question cards in native Codex Default mode', () => {
    it.each(['answer', 'cancel', 'interrupt', 'resume'] as const)('handles %s through the interactive question card', async action => {
        const root = await mkdtemp(join(tmpdir(), 'happy-question-'));
        const codexHome = join(root, 'codex-home');
        await mkdir(codexHome);
        const previousCodexHome = process.env.CODEX_HOME;
        const client = new CodexAppServerClient();
        let state: AgentState = {};
        const envelopes: SessionEnvelope[] = [];
        const rpcs = new Map<string, (raw: unknown) => Promise<unknown>>();
        let publishCard!: () => void;
        const cardPublished = new Promise<void>(res => { publishCard = res; });
        const session = {
            sessionId: 'fixture', sendClaudeSessionMessage: () => {},
            rpcHandlerManager: { registerHandler: (name: string, handler: (raw: unknown) => Promise<unknown>) => rpcs.set(name, handler) },
            sendSessionProtocolMessage: (envelope: SessionEnvelope) => { envelopes.push(envelope); },
            updateAgentState: (update: (current: AgentState) => AgentState) => {
                state = update(state);
                if (Object.keys(state.communications ?? {}).length > 0) publishCard();
            },
        } as unknown as ApiSessionClient;
        const handler = new CodexUserInputHandler(session, () => 'happy-turn');
        const happy = await startCodexHappyServer(session, handler);
        const errors: unknown[] = [];
        const requests: any[] = [];
        let seedResumeHistory = action === 'resume';
        const provider = createServer(async (request, response) => {
            try {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                let buffer = Buffer.concat(chunks);
                if (request.headers['content-encoding'] === 'gzip') buffer = gunzipSync(buffer);
                if (request.headers['content-encoding'] === 'deflate') buffer = inflateSync(buffer);
                const body = JSON.parse(buffer.toString());
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                if (seedResumeHistory) {
                    seedResumeHistory = false;
                    complete(response, { id: 'seed', type: 'message', role: 'assistant', status: 'completed',
                        content: [{ type: 'output_text', text: 'History saved.' }] });
                    return;
                }
                requests.push(body);
                if (requests.length === 1) {
                    const namespace = body.tools.find((tool: any) => tool.type === 'namespace' && tool.name === 'mcp__happy');
                    const tool = namespace?.tools.find((tool: any) => tool.name === 'request_user_input')
                        ?? body.tools.find((tool: any) => /happy.*request_user_input/.test(tool.name));
                    if (!tool) throw new Error(`Happy question tool missing: ${JSON.stringify(body.tools.map((tool: any) => ({ type: tool.type, name: tool.name, tools: tool.tools?.map((entry: any) => entry.name) })))}`);
                    // Codex should expose only the Happy tools backed by this server.
                    expect(namespace?.tools.some((tool: any) => tool.name === 'update_plan') ??
                        body.tools.some((tool: any) => /happy.*update_plan/.test(tool.name))).toBe(false);
                    complete(response, { id: 'question', type: 'function_call', call_id: 'question_call', name: tool.name,
                        ...(namespace ? { namespace: namespace.name } : {}),
                        arguments: JSON.stringify({ questions: [{ id: 'account', header: 'Account', question: 'Which account?',
                            options: [{ label: 'Alpha', description: 'First account' }, { label: 'Beta', description: 'Second account' }] }] }) });
                } else {
                    complete(response, { id: 'done', type: 'message', role: 'assistant', status: 'completed',
                        content: [{ type: 'output_text', text: 'Answer received.' }] });
                }
            } catch (error) {
                errors.push(error);
                if (!response.headersSent) response.writeHead(500).end();
                else response.destroy();
            }
        });
        await new Promise<void>(res => provider.listen(0, '127.0.0.1', res));
        const address = provider.address() as { port: number };
        await writeFile(join(codexHome, 'config.toml'), [
            'model = "gpt-test"', 'model_provider = "question_test"',
            '[model_providers.question_test]', 'name = "Local question test"',
            `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
            '[features]', 'shell_snapshot = false', 'code_mode = false',
        ].join('\n'));
        process.env.CODEX_HOME = codexHome;
        client.setEventHandler(message => {
            if (message.type === 'error') errors.push(message);
            const mapped = mapCodexMcpMessageToSessionEnvelopes(message, { currentTurnId: 'happy-turn' });
            envelopes.push(...mapped.envelopes);
        });
        try {
            await client.connect();
            await client.startThread({ model: 'gpt-test', cwd: root, sandbox: 'danger-full-access',
                approvalPolicy: 'never', mcpServers: happy.mcpServers });
            if (action === 'resume') {
                await client.sendTurnAndWait('Seed the history before resuming.');
                await client.resumeThread();
            }
            let finished = false;
            const turn = client.sendTurnAndWait(buildCodexTurnPrompt({ message: 'Ask which account to use.', mode: {},
                includeAppendSystemPrompt: false, includeTitleInstruction: false, includeQuestionInstruction: true }));
            void turn.then(() => { finished = true; });
            await bounded(Promise.race([cardPublished, turn.then(() => { throw new Error(`Turn ended before question: ${errors.map(error => error instanceof Error ? error.message : JSON.stringify(error)).join('; ')}`); })]));
            expect(finished).toBe(false);
            expect(requests).toHaveLength(1);
            const [id, communication] = Object.entries(state.communications!)[0];
            expect(communication.form.questions[0]).toMatchObject({ id: 'account', allowCustom: true,
                options: [{ label: 'Alpha' }, { label: 'Beta' }] });
            const answered = action === 'answer' || action === 'resume';
            if (answered) {
                await expect(rpcs.get('communication')!({ id, kind: 'form', status: 'answered' })).rejects.toThrow('Answer required');
                expect(handler.hasPending()).toBe(true);
                expect(requests).toHaveLength(1);
                await rpcs.get('communication')!({ id, kind: 'form', status: 'answered', answers: { account: { options: ['Beta'] } } });
            } else {
                if (action === 'interrupt') await client.interruptTurn();
                happy.cancelQuestions();
            }
            await expect(bounded(turn)).resolves.toEqual({ aborted: action === 'interrupt' });
            expect(errors).toEqual([]);
            expect(requests).toHaveLength(action === 'interrupt' ? 1 : 2);
            if (action !== 'interrupt') {
                const input = JSON.stringify(requests[1].input);
                expect(input).toContain(answered ? '\\"answers\\":[\\"Beta\\"]' : '\\"answers\\":{}');
            }
            expect(state.communications).toEqual({});
            expect(state.completedCommunications?.[id].status).toBe(answered ? 'answered' : 'cancelled');
            const cards = envelopes.filter(envelope => envelope.ev.t === 'tool-call-start' &&
                ['request_user_input', 'mcp__happy__request_user_input'].includes(envelope.ev.name));
            expect(cards).toHaveLength(1);
            expect(handler.hasPending()).toBe(false);
            expect(happy.mcpServers.happy.tool_timeout_sec).toBeGreaterThan(60);
        } finally {
            happy.stop();
            handler.reset();
            await client.disconnect();
            if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previousCodexHome;
            provider.closeAllConnections();
            await new Promise<void>(res => provider.close(() => res()));
            // Remove only the exact temporary tree this test created.
            if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('happy-question-')) throw new Error('Unexpected temporary root');
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }, 60000);
});
