import { describe, expect, it } from 'vitest'

import { AGENT_MODELS, agentModelById } from './catalog'

const UPSTREAM_MODEL_IDS = [
    'codex-default',
    'claude-default',
    'claude-sonnet',
    'claude-opus',
] as const

const FORK_MODEL_IDS = [
    'claude-fable-5-1[1m]',
    'claude-opus-5[1m]',
    'claude-sonnet-5[1m]',
    'claude-haiku-4-5',
] as const

describe('agent model catalog', () => {
    it('preserves the upstream catalog and appends only the required fork models', () => {
        expect(AGENT_MODELS.map((model) => model.id)).toEqual([
            ...UPSTREAM_MODEL_IDS,
            ...FORK_MODEL_IDS,
        ])
    })

    it.each(FORK_MODEL_IDS)('passes %s through to the Claude worker unchanged', (modelId) => {
        expect(agentModelById(modelId)).toMatchObject({
            id: modelId,
            engine: 'claude',
            model: modelId,
        })
    })
})
