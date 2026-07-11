import { describe, expect, it } from 'vitest'

import { anthropicPlugin } from './index'

describe('anthropicPlugin', () => {
    it('exposes base and 1M Fable 5 and Opus 4.8 model IDs', () => {
        const capability = anthropicPlugin.getCapabilities().find(
            (candidate) => candidate.type === 'llm-inference',
        )

        expect(capability?.type).toBe('llm-inference')
        if (!capability || capability.type !== 'llm-inference') return

        expect(capability.models.map((model) => model.id)).toEqual([
            'claude-fable-5',
            'claude-fable-5[1m]',
            'claude-opus-4-8',
            'claude-opus-4-8[1m]',
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-4-6',
        ])
    })
})
