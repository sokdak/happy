import { z } from 'zod';

/** Shared by Happy's HTTP MCP tools and their opt-in stdio bridge. */
export const agentQuestionSchema = z.object({
    id: z.string(), header: z.string(), question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).optional(),
    isOther: z.boolean().optional(), isSecret: z.boolean().optional(),
});
export const agentPlanSchema = z.array(z.object({
    step: z.string(), status: z.enum(['pending', 'in_progress', 'completed']),
}));
