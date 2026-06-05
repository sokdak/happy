import { describe, it, expect } from 'vitest';
import { mapToClaudeModel } from './modelAlias';

describe('mapToClaudeModel', () => {
    it('maps the bare opus alias to the explicit 4.8 id (SDK alias resolves to stale 4.7)', () => {
        expect(mapToClaudeModel('opus')).toBe('claude-opus-4-8');
    });

    it('maps sonnet/haiku aliases to the ids the UI advertises', () => {
        expect(mapToClaudeModel('sonnet')).toBe('claude-sonnet-4-6');
        expect(mapToClaudeModel('haiku')).toBe('claude-haiku-4-5');
    });

    it('passes concrete model ids through unchanged', () => {
        expect(mapToClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
        expect(mapToClaudeModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    });

    it('passes default and undefined through unchanged', () => {
        expect(mapToClaudeModel('default')).toBe('default');
        expect(mapToClaudeModel(undefined)).toBeUndefined();
    });
});
