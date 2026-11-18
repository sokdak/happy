/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { agentQuestionSchema, agentPlanSchema } from '@/utils/agentInteractionSchema';

export interface HappyInteractionTools {
    requestUserInput?: (questions: z.infer<typeof agentQuestionSchema>[], signal: AbortSignal) => Promise<unknown>;
    updatePlan?: (plan: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]) => Promise<unknown>;
}

function createMcpServer(handler: (title: string) => Promise<{ success: boolean; error?: string }>, interactions: HappyInteractionTools): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    if (interactions.requestUserInput) mcp.registerTool('request_user_input', {
        description: 'Ask the user up to three questions using Happy question cards. Wait for their answers before continuing dependent work.',
        inputSchema: { questions: z.array(agentQuestionSchema).min(1).max(3) },
    }, async (args, extra) => ({ content: [{ type: 'text', text: JSON.stringify(await interactions.requestUserInput!(args.questions, extra.signal)) }] }));
    if (interactions.updatePlan) mcp.registerTool('update_plan', {
        description: 'Publish the current task plan in Happy. Keep statuses updated as work progresses.',
        inputSchema: { plan: agentPlanSchema },
    }, async args => ({ content: [{ type: 'text', text: JSON.stringify(await interactions.updatePlan!(args.plan)) }] }));
    return mcp;
}

export async function startHappyServer(client: Pick<ApiSessionClient, 'sessionId' | 'sendClaudeSessionMessage'>, interactions: HappyInteractionTools = {}) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handler, interactions);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', ...(interactions.requestUserInput ? ['request_user_input'] : []), ...(interactions.updatePlan ? ['update_plan'] : [])],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
            server.closeAllConnections();
        }
    }
}
