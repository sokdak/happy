import { describe, expect, it } from 'vitest'

import { anthropicPlugin } from './index'

describe('anthropicPlugin', () => {
    it('exposes the current Anthropic model catalog', () => {
        const capability = anthropicPlugin.getCapabilities().find(
            (candidate) => candidate.type === 'llm-inference',
        )

        expect(capability?.type).toBe('llm-inference')
        if (!capability || capability.type !== 'llm-inference') return

        expect(capability.models.map((model) => model.id)).toEqual([
            'claude-opus-5',
            'claude-opus-5[1m]',
            'claude-fable-5',
            'claude-fable-5[1m]',
            'claude-sonnet-5',
            'claude-sonnet-5[1m]',
            'claude-haiku-4-5',
        ])
        expect(capability.models.map((model) => model.label)).toEqual([
            'Opus 5',
            'Opus 5 (1M)',
            'Fable 5',
            'Fable 5 (1M)',
            'Sonnet 5',
            'Sonnet 5 (1M)',
            'Haiku 4.5',
        ])
    })
})
