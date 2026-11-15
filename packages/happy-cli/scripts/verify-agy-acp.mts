/** Opt-in authenticated live verification. Creates only a temporary fixture workspace. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAcpBackend, AgyCancelledError } from '../src/agy/AgyAcpBackend';
import { AcpSessionManager } from '../src/agent/acp/AcpSessionManager';
import type { AgentMessage } from '../src/agent/core/AgentBackend';

const cwd = await mkdtemp(join(tmpdir(), 'happy-agy-acp-'));
await writeFile(join(cwd, 'README.md'), 'This is a disposable Happy ACP test fixture.\n');
const events: Array<{ turn: number; elapsedMs: number; type: string; tool?: string }> = [];
const texts = new Map<number, string>();
const started = Date.now();
let turn = 0;
let toolStarted: (() => void) | undefined;
const manager = new AcpSessionManager({ preserveTextWhitespace: true, forwardToolResults: true });
const envelopes: Array<{ turn: number; elapsedMs: number; type: string }> = [];
const emitEnvelopes = (items: ReturnType<typeof manager.mapMessage>) => {
  for (const item of items) envelopes.push({ turn, elapsedMs: Date.now() - started, type: item.ev.t });
};
function observe(message: AgentMessage) {
  events.push({ turn, elapsedMs: Date.now() - started, type: message.type, ...(message.type === 'tool-call' ? { tool: message.toolName } : {}) });
  if (message.type === 'model-output') texts.set(turn, (texts.get(turn) ?? '') + (message.textDelta ?? ''));
  if (message.type === 'tool-call' && message.toolName === 'Bash') toolStarted?.();
  emitEnvelopes(manager.mapMessage(message));
}
const options = { cwd, permissionMode: 'yolo' as const, model: 'Gemini 3.8 Flash', effort: 'low' };
let backend = new AgyAcpBackend(options);
backend.onMessage(observe);
const deadline = setTimeout(() => { void backend.dispose(); }, 180_000);
try {
  const { sessionId } = await backend.startSession();
  turn = 1; emitEnvelopes(manager.startTurn());
  await backend.sendPrompt(sessionId, `Remember marker ACP_CONTEXT_PINE_731. First say 'Checking the fixture now.' Then use read_file to read only line 1 of ${join(cwd, 'README.md')}. Then use run_command for exactly 'sleep 2'. Finally reply ACP_STREAM_OK. Use no other tools and modify nothing.`);
  const completedAt = Date.now() - started;
  emitEnvelopes(manager.endTurn('completed'));
  assert.match(texts.get(1) ?? '', /ACP_STREAM_OK/);
  assert(events.some(e => e.turn === 1 && e.tool === 'Read'));
  assert(events.some(e => e.turn === 1 && e.tool === 'Bash'));
  assert(envelopes.some(e => e.turn === 1 && e.type === 'tool-call-start' && e.elapsedMs < completedAt));

  turn = 2; emitEnvelopes(manager.startTurn());
  await backend.sendPrompt(sessionId, 'Reply with only the exact marker I asked you to remember. Do not use tools.');
  emitEnvelopes(manager.endTurn('completed'));
  assert.match(texts.get(2) ?? '', /ACP_CONTEXT_PINE_731/);

  await backend.dispose();
  backend = new AgyAcpBackend({ ...options, resumeSessionId: sessionId });
  backend.onMessage(observe);
  turn = 3; emitEnvelopes(manager.startTurn());
  await backend.startSession();
  backend.setModel('Gemini 4 Carbon');
  await backend.sendPrompt(sessionId, 'Reply with only the exact marker from the earlier conversation. Do not use tools.');
  emitEnvelopes(manager.endTurn('completed'));
  assert.match(texts.get(3) ?? '', /ACP_CONTEXT_PINE_731/);

  turn = 4; emitEnvelopes(manager.startTurn());
  await backend.sendPrompt(sessionId, 'What is the dominant color of this image? Reply only the color in English. Do not use tools.', [{
    type: 'image', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=',
  }]);
  emitEnvelopes(manager.endTurn('completed'));
  assert.match(texts.get(4) ?? '', /red/i);

  turn = 5; emitEnvelopes(manager.startTurn());
  const tool = new Promise<void>(resolve => { toolStarted = resolve; });
  const pending = backend.sendPrompt(sessionId, "Use run_command to execute exactly 'sleep 20'. Do not use other tools or modify anything.");
  const outcome = pending.then(() => 'completed', error => error instanceof AgyCancelledError ? 'cancelled' : Promise.reject(error));
  let toolTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([tool, new Promise<never>((_, reject) => { toolTimer = setTimeout(() => reject(new Error('Expected sleep tool did not start')), 45_000); })]);
  } finally { clearTimeout(toolTimer); }
  const cancelStarted = Date.now();
  await backend.cancel();
  assert.equal(await outcome, 'cancelled');
  emitEnvelopes(manager.endTurn('cancelled'));
  assert(Date.now() - cancelStarted < 8_000);

  turn = 6; emitEnvelopes(manager.startTurn());
  await backend.sendPrompt(sessionId, 'Reply only ACP_RECOVERY_OK. Do not use tools.');
  emitEnvelopes(manager.endTurn('completed'));
  assert.match(texts.get(6) ?? '', /ACP_RECOVERY_OK/);
  console.log(JSON.stringify({ passed: true, server: 'agy acp', scenarios: ['streaming', 'native tools', 'multi-turn context', 'explicit resume', 'model switch', 'image', 'cancel', 'post-cancel recovery'], events, envelopes }, null, 2));
} finally {
  clearTimeout(deadline);
  await backend.dispose(); await rm(cwd, { recursive: true, force: true });
}
