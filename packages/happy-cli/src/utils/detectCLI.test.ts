import { describe, expect, it } from 'vitest';
import { detectCLIAvailability } from './detectCLI';

describe('detectCLIAvailability', () => {
    it('applies the agent policy so a disallowed agent is never reported available', () => {
        const result = detectCLIAvailability({ HAPPY_ENABLED_AGENTS: 'gemini' });

        expect(result.claude).toBe(false);
        expect(result.codex).toBe(false);
        expect(result.openclaw).toBe(false);
        expect(result.agy).toBe(false);
    });
});
