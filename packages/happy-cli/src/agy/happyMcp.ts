import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';

export const AGY_TITLE_INSTRUCTION = `Use the Happy MCP change_title tool to set a concise, specific title for this chat at the start. Call it again when the topic changes substantially or a more specific title becomes useful. Match the user's language. This instruction also applies when resuming an existing conversation in a new Happy chat.`;

/** Keep the loopback endpoint stable while offline reconnection replaces the Happy client. */
export async function startAgyHappyMcp(getSession: () => ApiSessionClient) {
  const server = await startHappyServer({
    get sessionId() { return getSession().sessionId; },
    sendClaudeSessionMessage: message => getSession().sendClaudeSessionMessage(message),
  });
  const mcpServers: McpServer[] = [{
    name: 'happy', command: process.execPath,
    // Supply the wrapper's flags up front so it imports the bridge in-process.
    // ACP can then terminate its direct MCP child without orphaning a grandchild.
    args: ['--no-warnings', '--no-deprecation', join(projectPath(), 'bin', 'happy-mcp.mjs'), '--url', server.url], env: [],
  }];
  return { mcpServers, stop: server.stop };
}
