import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApiSessionClient } from '@/api/apiSession';
import { startAgyHappyMcp } from './happyMcp';
import { AgyPermissionHandler } from './permissionHandler';

describe('Antigravity Happy title MCP', () => {
  it('updates the current Happy client through the real MCP endpoint, including after reconnect', async () => {
    const first = { sessionId: 'offline', sendClaudeSessionMessage: vi.fn() };
    const second = { sessionId: 'online', sendClaudeSessionMessage: vi.fn() };
    let session = first;
    const server = await startAgyHappyMcp(() => session as unknown as ApiSessionClient);
    const client = new Client({ name: 'title-test', version: '1' });
    try {
      const config = server.mcpServers[0];
      expect('command' in config && config.command).toBe(process.execPath);
      const url = 'args' in config ? config.args.at(-1)! : '';
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['change_title']);
      expect((await client.callTool({ name: 'change_title', arguments: { title: '첫 제목' } })).isError).toBe(false);
      session = second;
      await client.callTool({ name: 'change_title', arguments: { title: '바뀐 주제' } });
      expect(first.sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
      expect(second.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'summary', summary: '바뀐 주제' }));
    } finally { await client.close(); server.stop(); }
  });

  it('auto-approves only exact Happy title tool names', async () => {
    const updateAgentState = vi.fn();
    const handler = new AgyPermissionHandler({ updateAgentState, rpcHandlerManager: { registerHandler: vi.fn() } } as unknown as ApiSessionClient);
    for (const name of ['change_title', 'happy__change_title', 'mcp__happy__change_title']) {
      expect(await handler.handleToolCall(name, name, {})).toEqual({ decision: 'approved' });
    }
    expect(updateAgentState).not.toHaveBeenCalled();
    const pending = handler.handleToolCall('unsafe', 'mcp__happy__change_title_and_run_command', {});
    expect(updateAgentState).toHaveBeenCalled();
    const rejected = expect(pending).rejects.toThrow('Session reset');
    handler.reset();
    await rejected;
  });
});
