export type AgentEngine = 'codex' | 'claude'

export interface AgentModel {
    id: string
    engine: AgentEngine
    label: string
    group: string
    model?: string
    description?: string
}

export const AGENT_MODELS: AgentModel[] = [
    {
        id: 'codex-default',
        engine: 'codex',
        label: 'Codex',
        group: 'OpenAI',
        description: 'Bundled Codex CLI default model.',
    },
    {
        id: 'claude-default',
        engine: 'claude',
        label: 'Claude',
        group: 'Anthropic',
        description: 'Bundled Claude Agent SDK default model.',
    },
    {
        id: 'claude-sonnet',
        engine: 'claude',
        label: 'Sonnet',
        group: 'Anthropic',
        model: 'sonnet',
    },
    {
        id: 'claude-opus',
        engine: 'claude',
        label: 'Opus',
        group: 'Anthropic',
        model: 'opus',
    },
    {
        id: 'claude-fable-5-1[1m]',
        engine: 'claude',
        label: 'Fable 5.1 (1M)',
        group: 'Anthropic',
        model: 'claude-fable-5-1[1m]',
        description: 'Fable 5.1 with a 1M-token context window.',
    },
    {
        id: 'claude-opus-5[1m]',
        engine: 'claude',
        label: 'Opus 5 (1M)',
        group: 'Anthropic',
        model: 'claude-opus-5[1m]',
        description: 'Opus 5 with a 1M-token context window.',
    },
    {
        id: 'claude-sonnet-5[1m]',
        engine: 'claude',
        label: 'Sonnet 5 (1M)',
        group: 'Anthropic',
        model: 'claude-sonnet-5[1m]',
        description: 'Sonnet 5 with a 1M-token context window.',
    },
    {
        id: 'claude-haiku-4-5',
        engine: 'claude',
        label: 'Haiku 4.5',
        group: 'Anthropic',
        model: 'claude-haiku-4-5',
        description: 'Fastest Claude model.',
    },
]

export function agentModelById(id: string): AgentModel {
    return AGENT_MODELS.find((model) => model.id === id) ?? AGENT_MODELS[0]
}
