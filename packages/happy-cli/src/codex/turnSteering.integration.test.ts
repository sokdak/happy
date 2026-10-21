/**
 * Real Codex + a local scripted Responses provider; no API key or model calls.
 * Requires Codex 0.159+ on PATH, otherwise skipped. From packages/happy-cli:
 * node ../../node_modules/vitest/vitest.mjs run --project integration-codex-local
 * Direct Node invocation preserves PATH instead of preferring workspace shims.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexTurnSteering, type CodexPendingMessage } from './codexTurnSteering';

function codexAvailable(): boolean {
    try {
        const output = process.platform === 'win32'
            ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'codex --version'], { encoding: 'utf8', windowsHide: true })
            : execFileSync('codex', ['--version'], { encoding: 'utf8' });
        const match = output.match(/codex-cli (\d+)\.(\d+)/);
        return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 159);
    } catch { return false; }
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(res => { resolve = res; });
    return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Codex steering boundary timed out')), 15000); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function event(response: ServerResponse, data: Record<string, unknown>): void {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function complete(response: ServerResponse, number: number, item: Record<string, unknown>): void {
    event(response, { type: 'response.output_item.added', output_index: 0, item });
    event(response, { type: 'response.output_item.done', output_index: 0, item });
    event(response, { type: 'response.completed', response: {
        id: `response_${number}`, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
    } });
    response.end();
}

describe.skipIf(!codexAvailable())('native Codex steering with a local Responses provider', () => {
    it.each(['responding', 'running a tool'] as const)('reads the new instruction before its next tool when %s', async phase => {
        const root = await mkdtemp(join(tmpdir(), 'happy-steer-'));
        const codexHome = join(root, 'codex-home');
        const releaseFile = join(root, 'release');
        await mkdir(codexHome);
        const previousCodexHome = process.env.CODEX_HOME;
        const client = new CodexAppServerClient();
        const firstResponseStarted = deferred();
        const firstToolStarted = deferred();
        const releaseResponse = deferred();
        const accepted = deferred();
        const providerInputs: unknown[] = [];
        const commands: string[] = [];
        const errors: unknown[] = [];
        const queued: CodexPendingMessage[] = [];
        const instruction = 'STEERING_SENTINEL: use the revised command before your next tool.';
        const output = (text: string) => process.platform === 'win32' ? `Write-Output '${text}'` : `printf '%s\\n' '${text}'`;
        const firstCommand = process.platform === 'win32'
            ? `while (-not (Test-Path -LiteralPath '${releaseFile.replace(/'/g, "''")}')) { Start-Sleep -Milliseconds 25 }; ${output('first-command')}`
            : `while [ ! -f '${releaseFile.replace(/'/g, "'\\''")}' ]; do sleep 0.025; done; ${output('first-command')}`;
        const provider = createServer(async (request, response) => {
            try {
                if (!request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const raw = Buffer.concat(chunks);
                const encoding = request.headers['content-encoding'];
                const decompressZstd = Reflect.get(zlib, 'zstdDecompressSync') as ((input: Buffer) => Buffer) | undefined;
                if (encoding === 'zstd' && !decompressZstd) throw new Error('Zstandard requests require Node with Zstandard support');
                const decoded = encoding === 'zstd' ? decompressZstd!(raw) : encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
                const body = JSON.parse(decoded.toString());
                providerInputs.push(body.input);
                const number = providerInputs.length;
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                event(response, { type: 'response.created', response: { id: `response_${number}`, status: 'in_progress', output: [] } });
                if (number === 1 && phase === 'responding') {
                    firstResponseStarted.resolve();
                    await releaseResponse.promise;
                    if (response.destroyed) return;
                }
                if (number > 2) {
                    complete(response, number, { id: `message_${number}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] });
                    return;
                }
                const sawInstruction = JSON.stringify(body.input).includes(instruction);
                const command = number === 1 ? firstCommand : output(sawInstruction ? 'revised-command' : 'stale-command');
                const name = body.tools.find((tool: any) => ['exec_command', 'shell_command', 'shell'].includes(tool.name))?.name;
                if (!name) throw new Error(`No shell tool: ${JSON.stringify(body.tools.map((tool: any) => tool.name ?? tool.type))}`);
                const args = name === 'exec_command' ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 }
                    : name === 'shell_command' ? { command, timeout_ms: 10000 }
                        : { command: process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-Command', command] : ['sh', '-c', command], timeout_ms: 10000 };
                complete(response, number, { id: `function_${number}`, type: 'function_call', call_id: `call_${number}`, name, arguments: JSON.stringify(args) });
            } catch (error) {
                errors.push(error);
                if (!response.headersSent) response.writeHead(500).end();
                else response.destroy();
            }
        });
        await new Promise<void>(res => provider.listen(0, '127.0.0.1', res));
        const address = provider.address() as { port: number };
        await writeFile(join(codexHome, 'config.toml'), [
            'model = "gpt-test"', 'model_provider = "steering_test"',
            '[model_providers.steering_test]', 'name = "Local steering test"',
            `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
            '[features]', 'shell_snapshot = false', 'code_mode = false',
        ].join('\n'));
        process.env.CODEX_HOME = codexHome;
        client.setEventHandler(message => {
            if (message.type === 'exec_command_begin') {
                commands.push(JSON.stringify(message.command));
                firstToolStarted.resolve();
            }
            if (message.type === 'error') errors.push(message);
        });
        const router = new CodexTurnSteering({
            enqueue: input => { queued.push(input); }, hasQueuedMessages: () => queued.length > 0,
            steer: async (input, target) => {
                const result = await client.steerTurn(input.message, target);
                if (result) accepted.resolve();
                return result;
            },
            onError: error => { errors.push(error); },
        });
        try {
            await client.connect();
            await client.startThread({ model: 'gpt-test', cwd: root, sandbox: 'danger-full-access', approvalPolicy: 'never' });
            const mode = { permissionMode: 'yolo' as const, model: 'gpt-test' };
            const turn = router.runTurn(mode, onTurnStarted => client.sendTurnAndWait('Run the first command, then another command.', { onTurnStarted }));
            // Fail promptly if Codex ends before reaching the controlled boundary.
            await bounded(Promise.race([
                phase === 'responding' ? firstResponseStarted.promise : firstToolStarted.promise,
                turn.then(() => { throw new Error(`Codex finished early: ${JSON.stringify(errors)}`); }),
            ]));
            router.submit({ message: instruction, mode });
            await bounded(accepted.promise);
            await writeFile(releaseFile, 'release');
            await vi.waitFor(() => expect(providerInputs.length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
            releaseResponse.resolve();
            await expect(bounded(turn)).resolves.toEqual({ aborted: false, timedOut: false });
            expect(errors).toEqual([]);
            expect(JSON.stringify(providerInputs[1])).toContain(instruction);
            expect(commands.at(-1)).toContain('revised-command');
            expect(commands).toHaveLength(phase === 'responding' ? 1 : 2);
            expect(commands.join(' ')).not.toContain('stale-command');
            expect(queued).toEqual([]);
        } finally {
            releaseResponse.resolve();
            await writeFile(releaseFile, 'release');
            await client.disconnect();
            if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previousCodexHome;
            provider.closeAllConnections();
            await new Promise<void>(res => provider.close(() => res()));
            // Only remove the exact temporary tree created by this test.
            if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('happy-steer-')) throw new Error('Unexpected temporary root');
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    }, 60000);
});
