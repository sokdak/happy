import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { knownTools } from './knownTools';

describe('knownTools', () => {
    it('hides Claude Skill tool calls from chat rendering', () => {
        expect((knownTools as Record<string, { hidden?: boolean }>).Skill?.hidden).toBe(true);
    });

    it('renders Claude Workflow tool calls compactly', () => {
        const workflow = knownTools.Workflow;

        expect(workflow).toBeDefined();
        expect('hidden' in workflow ? workflow.hidden : undefined).not.toBe(true);
        expect(workflow.minimal).toBe(true);
        expect(workflow.title).toBe('workflows.toolTitle');
        expect(workflow.input.safeParse({
            script: 'export default workflow({ phases: [] })',
            future_field: true,
        }).success).toBe(true);
    });
});
