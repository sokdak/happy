/** Authenticated, opt-in live checks. Only exact fixture commands are approved. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { AgyAcpBackend, AgyCancelledError } from '../src/agy/AgyAcpBackend';
import type { AgentMessage } from '../src/agent/core/AgentBackend';

const scenario = process.argv[2] ?? 'single';
assert(['single', 'slow', 'chain', 'parallel', 'failure', 'denied', 'cancel', 'cancel-after-hook', 'watcher', 'hooks', 'broken-hook', 'collision'].includes(scenario));
const cwd = await mkdtemp(join(tmpdir(), 'happy-stop-live-'));
const commands = {
  a: 'sleep 15; printf A_DONE', b: 'sleep 15; printf B_DONE', slow: 'sleep 65; printf SLOW_DONE', final: 'printf FOLLOWUP_DONE',
  fail: 'sleep 15; exit 7', cancel: 'sleep 20; printf CANCEL_TASK_DONE',
  watcher: 'sleep 90; printf WATCHER_DONE',
};
const allowed = new Set(Object.values(commands));
const messages: AgentMessage[] = [], logs: string[] = [], permissions: { tool: string; approved: boolean }[] = [];
let started!: () => void;
const startedPromise = new Promise<void>(resolve => { started = resolve; });
const backend = new AgyAcpBackend({ cwd, permissionMode: 'default', model: 'Gemini 3.8 Flash', effort: 'high',
  spawnFn: ((file: string, args: string[], options: any) => {
    if (scenario === 'broken-hook' || scenario === 'cancel-after-hook') {
      const configPath = join(args.at(-1)!, '.agents/hooks.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (scenario === 'broken-hook') config['happy-acp-background'].Stop[0].command = 'exit 1';
      else config['happy-acp-background'].Stop[0].command += " && printf seen > '" + join(cwd, 'hook-seen').replace(/'/g, "'\\''") + "'";
      writeFileSync(configPath, JSON.stringify(config));
    }
    return spawn(file, args, options);
  }) as typeof spawn,
  log: message => logs.push(message),
  requestPermission: async (_id, tool, input) => {
    const command = (input as Record<string, unknown>)?.command;
    const approved = scenario !== 'denied' && tool === 'Bash' && typeof command === 'string' && allowed.has(command);
    permissions.push({ tool, approved }); return { decision: approved ? 'approved' : 'denied' };
  },
});
backend.onMessage(message => {
  messages.push(message);
  if (message.type === 'tool-call' && message.toolName === 'Bash') started();
});
let timer: ReturnType<typeof setTimeout>;
const deadline = new Promise<never>((_, reject) => {
  timer = setTimeout(() => { void backend.dispose(); reject(new Error('Live scenario deadline')); }, 150_000);
});
void deadline.catch(() => {});
const run = (prompt: string) => Promise.race([backend.sendPrompt('', prompt), deadline]);
const base = 'Harmless background lifecycle fixture. No files, network or unrelated commands. Use WaitMsBeforeAsync=1 for each sleep command. '
  + 'While a command runs, say WAITING and end the response. Do not rerun any command. ';
let error: string | undefined;
let sessionId = '';
let passed = false;
try {
  if (scenario === 'collision') {
    await mkdir(join(cwd, '.agents'));
    await writeFile(join(cwd, '.agents/hooks.json'), JSON.stringify({ 'happy-acp-background': { enabled: false } }));
  } else if (scenario === 'hooks') {
    await mkdir(join(cwd, '.agents'));
    await writeFile(join(cwd, '.agents/hooks.json'), JSON.stringify({ 'fixture-existing-hook': {
      Stop: [{ type: 'command', command: "printf 'seen\\n' >> existing-hook.log; printf '{}'", timeout: 5 }],
    } }));
  }
  sessionId = (await backend.startSession()).sessionId;
  if (scenario === 'cancel' || scenario === 'cancel-after-hook') {
    const outcome = run(base + `Run exactly \"${commands.cancel}\" then run \"${commands.final}\".`)
      .then(() => 'completed', e => e instanceof AgyCancelledError ? 'cancelled' : Promise.reject(e));
    await Promise.race([startedPromise, deadline]);
    if (scenario === 'cancel-after-hook') {
      let seen = false;
      for (let i = 0; i < 450 && !seen; i++) {
        try { seen = (await readFile(join(cwd, 'hook-seen'), 'utf8')) === 'seen'; } catch { /* Not yet invoked. */ }
        if (!seen) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(seen, 'fixture did not observe a Stop hook before cancellation');
    } else await new Promise(resolve => setTimeout(resolve, 2500));
    const before = Date.now(); await backend.cancel(); assert.equal(await outcome, 'cancelled');
    assert(Date.now() - before < 8000);
    const count = messages.length;
    await new Promise(resolve => setTimeout(resolve, 2000)); assert.equal(messages.length, count, 'late events after cancellation');
    assert(!messages.some(m => m.type === 'tool-call' && m.args.command === commands.final));
    await run('Reply exactly RECOVERED. Do not use tools.');
    assert(messages.some(m => m.type === 'model-output' && m.textDelta?.includes('RECOVERED')));
  } else {
    const prompt = scenario === 'chain' ? `Run \"${commands.a}\". After A completes, run \"${commands.b}\". After B completes, run \"${commands.final}\". Finally reply ALL_DONE.`
      : scenario === 'parallel' ? `Run \"${commands.a}\" and \"${commands.b}\" as separate background tool calls. Once BOTH complete run \"${commands.final}\" and reply ALL_DONE.`
      : scenario === 'slow' ? `Run \"${commands.slow}\". Once it completes run \"${commands.final}\" and reply ALL_DONE.`
      : scenario === 'failure' ? `Run \"${commands.fail}\". Once it finishes report its exit code and reply FAILED_AS_EXPECTED. Do not retry.`
      : scenario === 'denied' ? `Run \"${commands.a}\". If permission is denied, do not retry or find another route; reply DENIED_AS_EXPECTED.`
      : scenario === 'watcher' ? `Run \"${commands.watcher}\" exactly once as a simulated intentional background watcher. Do not wait or check status; reply WATCHER_STARTED and finish. The timer eventually exits to avoid a permanent fixture process.`
      : `Remember STOP_CONTEXT_731. Run \"${commands.a}\". Once it completes run \"${commands.final}\" and reply ALL_DONE.`;
    try { await run(base + prompt); } catch (e) { error = String(e); if (!['watcher', 'denied', 'broken-hook', 'collision'].includes(scenario)) throw e; }
    const text = messages.filter(m => m.type === 'model-output').map(m => m.textDelta ?? '').join('');
    if (scenario === 'broken-hook' || (scenario === 'collision' && error)) {
      assert.match(error ?? '', /unconfirmed/);
      assert(!messages.some(m => m.type === 'status' && m.status === 'idle'));
      assert(!messages.some(m => m.type === 'tool-call' && m.args.command === commands.final));
    } else if (scenario === 'watcher') {
      // The native timer may finish before limits are reached. Either confirmed
      // completion or explicit incomplete is valid; silent early idle is not.
      if (error) assert.match(error, /unconfirmed/);
      else assert(logs.some(l => /idle=true/.test(l)));
    } else if (scenario === 'failure') {
      assert.match(text, /FAILED_AS_EXPECTED/);
      // AGY marks a successfully executed shell tool completed even when the
      // command exits nonzero. Verify reported exit code and absence of retries.
      assert.match(text, /(?:exit code|code)\s*[:`*]*\s*7/i);
      assert.equal(messages.filter(m => m.type === 'tool-call' && m.args.command === commands.fail).length, 1);
    } else if (scenario === 'denied') {
      assert.match(error ?? '', /permission was denied/);
      assert.equal(permissions.length, 1); assert(permissions.every(p => !p.approved));
      assert(!messages.some(m => m.type === 'status' && m.status === 'idle'));
    }
    else {
      assert.match(text, /ALL_DONE/);
      const calls = messages.filter(m => m.type === 'tool-call' && m.toolName === 'Bash');
      const expectedCommands = scenario === 'slow'
        ? [commands.slow, commands.final]
        : [commands.a, commands.final, ...(['chain', 'parallel'].includes(scenario) ? [commands.b] : [])];
      for (const command of expectedCommands) {
        assert.equal(calls.filter(m => m.type === 'tool-call' && m.args.command === command).length, 1, 'missing/duplicated command');
      }
      assert(logs.some(l => /[1-9]\d* continuations/.test(l)), 'fixture did not exercise Stop continuation');
      if (scenario === 'single') {
        const offset = messages.length;
        await run('Reply with the exact context marker from the previous request. No tools.');
        assert.match(messages.slice(offset).filter(m => m.type === 'model-output').map(m => m.textDelta).join(''), /STOP_CONTEXT_731/);
      }
      if (scenario === 'hooks') assert.match(await readFile(join(cwd, '.agents/existing-hook.log'), 'utf8'), /seen/);
    }
  }
  passed = true;
} finally {
  clearTimeout(timer!); await backend.dispose();
  // Do not claim that disposing ACP terminated native background commands.
  // Fixtures use self-terminating sleeps, no network listeners or persistent writes.
  const evidence = { passed, scenario, sessionId, error, permissions, logs,
    events: messages.map(m => m.type === 'event' ? { type: m.type, name: m.name }
      : m.type === 'model-output' ? { type: m.type, text: m.textDelta } : m),
  };
  console.log(JSON.stringify(evidence, null, 2));
  await rm(cwd, { recursive: true, force: true });
}
