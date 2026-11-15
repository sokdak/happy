/** Opt-in live title test; uses a disposable workspace and a loopback Happy MCP server. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSessionClient } from '../src/api/apiSession';
import { AgyAcpBackend } from '../src/agy/AgyAcpBackend';
import { startAgyHappyMcp, AGY_TITLE_INSTRUCTION } from '../src/agy/happyMcp';
import { AgyPermissionHandler } from '../src/agy/permissionHandler';

const cwd = await mkdtemp(join(tmpdir(), 'happy-agy-title-'));
const titles: string[] = [];
const client = {
  sessionId: 'live-title-fixture',
  sendClaudeSessionMessage: (message: any) => { if (message.type === 'summary') titles.push(message.summary); },
  updateAgentState: () => {}, rpcHandlerManager: { registerHandler: () => {} },
} as unknown as ApiSessionClient;
const server = await startAgyHappyMcp(() => client);
const permissions = new AgyPermissionHandler(client);
let backend: AgyAcpBackend;
const options = {
  cwd, permissionMode: 'default' as const, model: 'Gemini 3.8 Flash', effort: 'low',
  mcpServers: server.mcpServers, initialPrompt: AGY_TITLE_INSTRUCTION,
  requestPermission: (id: string, name: string, input: unknown) => permissions.handleToolCall(id, name, input),
  resetPermissions: () => permissions.reset(),
};
backend = new AgyAcpBackend(options);
const deadline = setTimeout(() => { void backend.dispose(); }, 90_000);
try {
  const { sessionId } = await backend.startSession();
  await backend.sendPrompt(sessionId, 'Explain how to grow basil in two sentences. Do not use file or command tools.');
  assert(titles.length > 0 && titles[0].trim(), 'Automatic initial Happy summary missing');
  await backend.sendPrompt(sessionId, 'The topic has changed to garden planning. Use the Happy change_title tool to change the title to exactly ACP_TITLE_GARDEN. Reply done.');
  assert(titles.includes('ACP_TITLE_GARDEN'), 'Changed-topic Happy summary missing');
  await backend.dispose();
  backend = new AgyAcpBackend({ ...options, resumeSessionId: sessionId });
  await backend.startSession();
  await backend.sendPrompt(sessionId, 'This is a new Happy chat wrapping the resumed conversation. Use Happy change_title to set exactly ACP_TITLE_RESUMED. Reply done.');
  assert(titles.includes('ACP_TITLE_RESUMED'), 'Resumed Happy summary missing');
  console.log(JSON.stringify({ passed: true, scenarios: ['initial title', 'topic change', 'explicit resume'], titles }));
} finally {
  clearTimeout(deadline); await backend.dispose(); server.stop();
  await rm(cwd, { recursive: true, force: true });
}
