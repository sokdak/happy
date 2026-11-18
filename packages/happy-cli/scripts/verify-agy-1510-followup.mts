/**
 * Disposable authenticated live verification for AGY 1.5.10 post-end_turn background follow-ups.
 * Uses isolated temporary workspaces and approves only exact harmless Python fixture commands.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionManager } from '../src/agent/acp/AcpSessionManager';
import type { AgentMessage } from '../src/agent/core/AgentBackend';
import { AgyAcpBackend, AgyCancelledError } from '../src/agy/AgyAcpBackend';

const SCENARIOS = [
  'observer-approve',
  'observer-deny',
  'observer-cancel',
  'observer-parallel',
  'observer-chain',
  'observer-resume',
  'observer-daemon',
  'hook-off-overlap',
] as const;
type Scenario = (typeof SCENARIOS)[number];

const arg = process.argv[2] ?? 'all';
const outDirArg = process.argv[3];
const selected: Scenario[] = arg === 'all'
  ? [...SCENARIOS]
  : SCENARIOS.includes(arg as Scenario)
    ? [arg as Scenario]
    : (() => { throw new Error(`Unknown scenario: ${arg}`); })();

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await delay(120);
  return check();
}

async function runScenario(scenario: Scenario, artifactDir?: string) {
  const cwd = await mkdtemp(join(tmpdir(), `happy-agy-1510-${scenario}-`));
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const bg1 = `python3 ${join(cwd, 'bg1.py')}`;
  const bg2 = `python3 ${join(cwd, 'bg2.py')}`;
  const followup = `python3 ${join(cwd, 'followup.py')}`;
  const daemonCmd = `python3 ${join(cwd, 'daemon_task.py')}`;
  const allowed = new Set([bg1, bg2, followup, daemonCmd]);

  await writeFile(join(cwd, 'bg1.py'), [
    'import os, time, pathlib',
    'p = pathlib.Path(__file__).parent',
    "(p / 'bg1-started').write_text(str(os.getpid()))",
    "with (p / 'executions').open('a') as f: f.write('bg1\\n')",
    'deadline = time.monotonic() + 90',
    "while not (p / 'release1').exists() and time.monotonic() < deadline: time.sleep(0.1)",
    "if not (p / 'release1').exists(): raise SystemExit(2)",
    "(p / 'bg1-done').write_text('1')",
    "print('BG1_DONE', flush=True)",
  ].join('\n'));

  await writeFile(join(cwd, 'bg2.py'), [
    'import os, time, pathlib',
    'p = pathlib.Path(__file__).parent',
    "(p / 'bg2-started').write_text(str(os.getpid()))",
    "with (p / 'executions').open('a') as f: f.write('bg2\\n')",
    'deadline = time.monotonic() + 90',
    "while not (p / 'release2').exists() and time.monotonic() < deadline: time.sleep(0.1)",
    "if not (p / 'release2').exists(): raise SystemExit(2)",
    "(p / 'bg2-done').write_text('1')",
    "print('BG2_DONE', flush=True)",
  ].join('\n'));

  await writeFile(join(cwd, 'followup.py'), [
    'import pathlib',
    'p = pathlib.Path(__file__).parent',
    "with (p / 'executions').open('a') as f: f.write('followup\\n')",
    "(p / 'followup-done').write_text('1')",
    "print('FOLLOWUP_DONE', flush=True)",
  ].join('\n'));

  await writeFile(join(cwd, 'daemon_task.py'), [
    'import os, time, pathlib',
    'p = pathlib.Path(__file__).parent',
    "(p / 'daemon-started').write_text(str(os.getpid()))",
    'time.sleep(25)',
  ].join('\n'));

  const wire: any[] = [];
  const messages: any[] = [];
  const envelopes: any[] = [];
  const permissions: any[] = [];
  const logs: string[] = [];
  const reqMethods = new Map<string, string>();
  let promptRpcResolvedAt: number | undefined;
  let release1Scheduled = false;
  let release2Scheduled = false;
  let wireText = '';

  function observeRpc(direction: 'in' | 'out', rpc: any) {
    if (direction === 'out' && rpc.method && rpc.id !== undefined) {
      reqMethods.set(String(rpc.id), rpc.method);
    }
    const u = rpc.params?.update;
    if (direction === 'in' && u?.sessionUpdate === 'agent_thought_chunk') return;
    const entry: any = { ms: elapsed(), direction, id: rpc.id, method: rpc.method };
    if (direction === 'in' && rpc.id !== undefined && !rpc.method) {
      entry.replyTo = reqMethods.get(String(rpc.id));
      if (entry.replyTo === 'session/prompt') {
        promptRpcResolvedAt ??= elapsed();
        entry.stopReason = rpc.result?.stopReason;
      }
    }
    if (u) {
      entry.update = u.sessionUpdate;
      entry.toolCallId = u.toolCallId;
      entry.status = u.status;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        entry.text = u.content.text;
        wireText += u.content.text;
        if (wireText.includes('WAITING_INITIAL') && !release1Scheduled && scenario !== 'observer-cancel' && scenario !== 'hook-off-overlap') {
          release1Scheduled = true;
          setTimeout(() => { void writeFile(join(cwd, 'release1'), '1'); }, 2_000);
          if (scenario === 'observer-parallel') {
            release2Scheduled = true;
            setTimeout(() => { void writeFile(join(cwd, 'release2'), '1'); }, 6_500);
          }
        }
        if (scenario === 'observer-chain' && wireText.includes('WAITING_SECOND') && !release2Scheduled) {
          release2Scheduled = true;
          setTimeout(() => { void writeFile(join(cwd, 'release2'), '1'); }, 2_000);
        }
      }
    }
    wire.push(entry);
  }

  function observeStream(direction: 'in' | 'out') {
    let buf = '';
    return (chunk: any) => {
      buf += ArrayBuffer.isView(chunk)
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
        : String(chunk);
      while (buf.includes('\n')) {
        const idx = buf.indexOf('\n');
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try { observeRpc(direction, JSON.parse(line)); } catch {}
      }
    };
  }

  const spawnObserved: typeof spawn = ((file: string, args: string[], options: any) => {
    const p = spawn(file, args, options);
    p.stdout!.on('data', observeStream('in'));
    p.stderr!.on('data', () => {});
    const origWrite = p.stdin!.write;
    const out = observeStream('out');
    (p.stdin! as any).write = function (...wArgs: any[]) {
      out(wArgs[0]);
      return (origWrite as any).apply(this, wArgs);
    };
    return p;
  }) as typeof spawn;

  const manager = new AcpSessionManager({
    preserveTextWhitespace: true,
    forwardToolResults: true,
    allowPostTurnFollowups: true,
  });

  const makeBackend = (resumeSessionId?: string) => {
    const b = new AgyAcpBackend({
      cwd,
      stopHook: scenario === 'hook-off-overlap' ? false : 'observe',
      permissionMode: 'default',
      model: 'Gemini 3.8 Flash',
      effort: 'low',
      resumeSessionId,
      spawnFn: spawnObserved,
      log: m => logs.push(m),
      requestPermission: async (id, tool, input: any) => {
        const sessionCallId = manager.resolveSessionCallId(id);
        const cmd = input?.command;
        const approved = !(scenario === 'observer-deny' && cmd === followup)
          && tool === 'Bash'
          && typeof cmd === 'string'
          && allowed.has(cmd);
        permissions.push({ ms: elapsed(), id, sessionCallId, tool, command: cmd, approved });
        return { decision: approved ? 'approved' : 'denied' };
      },
    });
    b.onMessage((msg: AgentMessage) => {
      if (msg.type === 'event' && msg.name === 'thinking') return;
      messages.push({ ms: elapsed(), ...msg });
      for (const env of manager.mapMessage(msg)) {
        envelopes.push({ ms: elapsed(), ...env });
      }
    });
    return b;
  };

  let backend = makeBackend();
  let daemonPidToClean: number | undefined;
  let passed = false;
  let error: string | undefined;
  let sessionId = '';
  let cancelAliveAfter: boolean | undefined;

  const deadline = setTimeout(() => { void backend.dispose(); }, 160_000);
  try {
    sessionId = (await backend.startSession()).sessionId;

    if (scenario === 'observer-approve') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId,
        `Harmless lifecycle fixture. Use only these two commands. Run exactly "${bg1}" once with WaitMsBeforeAsync=1. `
        + `When it backgrounds, reply WAITING_INITIAL and end your response immediately without polling. `
        + `When BG1_DONE wakes you, run exactly "${followup}" once and reply FINAL_VISIBLE.`);
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));

      const happyText = messages.filter(m => m.type === 'model-output').map(m => m.textDelta ?? '').join('');
      const envelopeText = envelopes.filter(e => e.ev.t === 'text').map(e => e.ev.text).join('');
      assert(happyText.includes('WAITING_INITIAL') && happyText.includes('FINAL_VISIBLE'), 'missing happy text');
      assert(envelopeText.includes('WAITING_INITIAL') && envelopeText.includes('FINAL_VISIBLE'), 'missing envelope text');
      assert(envelopes.every(e => typeof e.turn === 'string' && e.turn.length > 0), 'missing turn on envelope');
      assert.deepEqual(envelopes.filter(e => e.ev.t === 'turn-end').map(e => e.ev.status), ['completed']);
      assert.equal(permissions.length, 2);
      assert(logs.some(l => l.includes('0 continuations, mode=observe')), 'expected 0 forced continuations');
    } else if (scenario === 'observer-deny') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      let deniedErr = '';
      try {
        await backend.sendPrompt(sessionId,
          `Harmless lifecycle fixture. Use only these two commands. Run "${bg1}" once with WaitMsBeforeAsync=1. `
          + `Reply WAITING_INITIAL and end your response immediately. When BG1_DONE arrives, run "${followup}" once. `
          + `If permission is denied, do not retry; reply DENIED_OK and stop.`);
        envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      } catch (e) {
        deniedErr = String(e);
        envelopes.push(...manager.endTurn('failed').map(e => ({ ms: elapsed(), ...e })));
      }
      assert.equal(existsSync(join(cwd, 'followup-done')), false, 'denied followup must not execute');
      assert.equal(permissions.filter(p => p.command === followup && !p.approved).length, 1);
      if (deniedErr) assert.match(deniedErr, /permission was denied/);
    } else if (scenario === 'observer-cancel') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      const turnPromise = backend.sendPrompt(sessionId,
        `Harmless lifecycle fixture. Run "${bg1}" once with WaitMsBeforeAsync=1. Reply WAITING_INITIAL and end your response immediately. `
        + `When BG1_DONE arrives, run "${followup}" and reply FINAL_VISIBLE.`)
        .then(() => 'completed', e => e instanceof AgyCancelledError ? 'cancelled' : Promise.reject(e));

      await waitFor(() => promptRpcResolvedAt !== undefined && existsSync(join(cwd, 'bg1-started')), 35_000);
      const pid = Number(await readFile(join(cwd, 'bg1-started'), 'utf8'));
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      await backend.cancel();
      assert.equal(await turnPromise, 'cancelled');
      envelopes.push(...manager.endTurn('cancelled').map(e => ({ ms: elapsed(), ...e })));
      await waitFor(() => !alive(), 10_000);
      cancelAliveAfter = alive();
      assert.equal(cancelAliveAfter, false, 'background task should terminate on session/cancel');
      const countAfterCancel = messages.length;
      await delay(1_500);
      assert.equal(messages.length, countAfterCancel, 'no late events after cancel');

      // Recovery prompt on the same session
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId, 'Reply exactly CANCEL_RECOVERY_OK without tools.');
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      const textAfter = envelopes.filter(e => e.ev.t === 'text').map(e => e.ev.text).join('');
      assert(textAfter.includes('CANCEL_RECOVERY_OK'), 'post-cancel recovery missing');
    } else if (scenario === 'observer-parallel') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId,
        `Harmless lifecycle fixture. Launch BOTH "${bg1}" and "${bg2}" with WaitMsBeforeAsync=1. `
        + `Reply WAITING_INITIAL and end your turn immediately. When only BG1_DONE arrives while bg2 still runs, `
        + `reply BG1_SEEN and end your turn without polling. When BG2_DONE also arrives, run "${followup}" once and reply FINAL_VISIBLE.`);
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      const envText = envelopes.filter(e => e.ev.t === 'text').map(e => e.ev.text).join('');
      assert(envText.includes('FINAL_VISIBLE'), 'missing FINAL_VISIBLE in parallel scenario');
      assert.deepEqual(envelopes.filter(e => e.ev.t === 'turn-end').map(e => e.ev.status), ['completed']);
    } else if (scenario === 'observer-chain') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId,
        `Harmless lifecycle fixture. First run "${bg1}" once with WaitMsBeforeAsync=1, reply WAITING_INITIAL, and end your turn. `
        + `When BG1_DONE arrives, run "${bg2}" once with WaitMsBeforeAsync=1, reply WAITING_SECOND, and end your turn. `
        + `When BG2_DONE arrives, run "${followup}" once and reply FINAL_VISIBLE.`);
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      const envText = envelopes.filter(e => e.ev.t === 'text').map(e => e.ev.text).join('');
      assert(envText.includes('FINAL_VISIBLE'), 'missing FINAL_VISIBLE in chain scenario');
      assert.deepEqual(envelopes.filter(e => e.ev.t === 'turn-end').map(e => e.ev.status), ['completed']);
    } else if (scenario === 'observer-resume') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId,
        `Remember RESUME_TOKEN_948. Run "${bg1}" once with WaitMsBeforeAsync=1, reply WAITING_INITIAL, and end your turn. `
        + `When BG1_DONE arrives, reply FINAL_VISIBLE.`);
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      await backend.dispose();

      const countBeforeResume = messages.length;
      backend = makeBackend(sessionId);
      const resumed = await backend.startSession();
      assert.equal(resumed.sessionId, sessionId);
      assert.equal(messages.slice(countBeforeResume).filter(m => m.type === 'model-output').length, 0, 'replay must be suppressed');

      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId, 'Reply with only the exact RESUME_TOKEN from earlier. No tools.');
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      const resumedText = messages.slice(countBeforeResume).filter(m => m.type === 'model-output').map(m => m.textDelta ?? '').join('');
      assert.match(resumedText, /RESUME_TOKEN_948/);
    } else if (scenario === 'observer-daemon') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId,
        `Harmless daemon fixture. Run "${daemonCmd}" once with IsDaemon=true and WaitMsBeforeAsync=500. `
        + `Then reply DAEMON_READY and end your turn immediately.`);
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));
      assert(existsSync(join(cwd, 'daemon-started')), 'daemon did not start');
      daemonPidToClean = Number(await readFile(join(cwd, 'daemon-started'), 'utf8'));
      assert.deepEqual(envelopes.filter(e => e.ev.t === 'turn-end').map(e => e.ev.status), ['completed']);
    } else if (scenario === 'hook-off-overlap') {
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      let firstOutcome = 'resolved';
      try {
        await backend.sendPrompt(sessionId,
          `Harmless overlap fixture. Run "${bg1}" once with WaitMsBeforeAsync=1, reply WAITING_INITIAL, and end your turn immediately. `
          + `When BG1_DONE arrives, run "${followup}" once and reply BG1_FOLLOWUP_VISIBLE.`);
      } catch {
        firstOutcome = 'unconfirmed';
      }
      envelopes.push(...manager.endTurn(firstOutcome === 'resolved' ? 'completed' : 'failed').map(e => ({ ms: elapsed(), ...e })));
      assert.equal(firstOutcome, 'unconfirmed');

      // Send a second user prompt while bg1 is still running!
      envelopes.push(...manager.startTurn().map(e => ({ ms: elapsed(), ...e })));
      await backend.sendPrompt(sessionId, 'Reply SECOND_PROMPT_DONE without using any tools.');
      envelopes.push(...manager.endTurn('completed').map(e => ({ ms: elapsed(), ...e })));

      // Now release bg1 and verify late completion + followup permission + text arrive without duplicate tool cards!
      await writeFile(join(cwd, 'release1'), '1');
      await waitFor(() => envelopes.some(e => e.ev.t === 'text' && e.ev.text.includes('BG1_FOLLOWUP_VISIBLE')), 50_000);
      assert.equal(existsSync(join(cwd, 'followup-done')), true, 'late followup should execute in hook-off overlap');
      const bgStarts = envelopes.filter(e => e.ev.t === 'tool-call-start' && e.ev.args?.command === bg1);
      const bgEnds = envelopes.filter(e => e.ev.t === 'tool-call-end' && e.ev.call === bgStarts[0]?.ev.call);
      assert.equal(bgStarts.length, 1, 'must not duplicate bg1 tool-call-start card');
      assert.equal(bgEnds.length, 1, 'bg1 tool-call-end must pair with original card');
    }

    const executions = existsSync(join(cwd, 'executions'))
      ? (await readFile(join(cwd, 'executions'), 'utf8')).trim().split('\n').filter(Boolean)
      : [];
    for (const cmdName of new Set(executions)) {
      assert.equal(executions.filter(x => x === cmdName).length, 1, `duplicate execution for ${cmdName}`);
    }
    passed = true;
    return {
      scenario,
      passed,
      sessionId,
      promptSentCount: wire.filter(w => w.direction === 'out' && w.method === 'session/prompt').length,
      executions,
      permissionCount: permissions.length,
      turnStates: envelopes.filter(e => e.ev.t === 'turn-end').map(e => e.ev.status),
      cancelAliveAfter,
      logs,
      artifactSaved: Boolean(artifactDir),
      ...(artifactDir ? { wire, messages, envelopes, permissions } : {}),
    };
  } catch (e) {
    error = String(e);
    throw e;
  } finally {
    clearTimeout(deadline);
    if (daemonPidToClean) {
      try { process.kill(daemonPidToClean, 'SIGTERM'); } catch {}
    }
    await backend.dispose();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, `${scenario}.json`), JSON.stringify({
        scenario, passed, error, sessionId, logs, permissions, envelopes, messages, wire,
      }, null, 2));
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

const results = [];
for (const scenario of selected) {
  const res = await runScenario(scenario, outDirArg);
  const { wire: _w, messages: _m, envelopes: _e, permissions: _p, ...compact } = res as any;
  results.push(compact);
  console.log(JSON.stringify(compact));
}
if (outDirArg) {
  await writeFile(join(outDirArg, 'followup-suite-summary.json'), JSON.stringify({ allPassed: true, results }, null, 2));
}
