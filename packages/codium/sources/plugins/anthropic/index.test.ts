import { describe, expect, it } from 'vitest'

import { anthropicPlugin } from './index'

describe('anthropicPlugin', () => {
    it('adds the required explicit model IDs without dropping the upstream catalog', () => {
        const capability = anthropicPlugin.getCapabilities().find(
            (candidate) => candidate.type === 'llm-inference',
        )

        expect(capability?.type).toBe('llm-inference')
        if (!capability || capability.type !== 'llm-inference') return

        expect(capability.models.map((model) => model.id)).toEqual([
            'claude-fable-5[1m]',
            'claude-opus-5[1m]',
            'claude-opus-4-8',
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-5[1m]',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
        ])
    })
})
