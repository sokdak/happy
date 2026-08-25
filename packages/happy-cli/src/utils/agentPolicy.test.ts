import { describe, expect, it } from 'vitest';
import { applyAgentPolicy, resolveSpawnAgent } from './agentPolicy';
import type { CLIAvailability } from './detectCLI';

const allInstalled = (): CLIAvailability => ({
    claude: true,
    codex: true,
    gemini: true,
    openclaw: true,
    agy: true,
    detectedAt: 0,
});

const codexOnly = (): CLIAvailability => ({
    claude: false,
    codex: true,
    gemini: false,
    openclaw: false,
    agy: false,
    detectedAt: 0,
});

describe('applyAgentPolicy', () => {
    it('marks an agent unavailable when HAPPY_DISABLED_AGENTS names it', () => {
        const result = applyAgentPolicy(allInstalled(), { HAPPY_DISABLED_AGENTS: 'claude' });

        expect(result.claude).toBe(false);
        expect(result.codex).toBe(true);
    });

    it('leaves only the allowlisted agents available when HAPPY_ENABLED_AGENTS is set', () => {
        const result = applyAgentPolicy(allInstalled(), { HAPPY_ENABLED_AGENTS: 'codex' });

        expect(result.codex).toBe(true);
        expect(result.claude).toBe(false);
        expect(result.gemini).toBe(false);
        expect(result.openclaw).toBe(false);
        expect(result.agy).toBe(false);
    });
});

describe('resolveSpawnAgent', () => {
    it('coerces a request for a disabled agent to an enabled one', () => {
        const result = resolveSpawnAgent('claude', codexOnly, { HAPPY_DISABLED_AGENTS: 'claude' });

        expect(result).toEqual({ type: 'ok', agent: 'codex', coercedFrom: 'claude' });
    });

    it('resolves an unspecified agent to the first enabled one', () => {
        const result = resolveSpawnAgent(undefined, codexOnly, { HAPPY_DISABLED_AGENTS: 'claude' });

        expect(result).toEqual({ type: 'ok', agent: 'codex' });
    });

    it('reports an error when the policy leaves no agent enabled', () => {
        const nothingEnabled: CLIAvailability = {
            claude: false,
            codex: false,
            gemini: false,
            openclaw: false,
            agy: false,
            detectedAt: 0,
        };

        const result = resolveSpawnAgent('claude', () => nothingEnabled, { HAPPY_ENABLED_AGENTS: 'codex' });

        expect(result.type).toBe('error');
    });

    it('rejects an agent this CLI does not know how to launch', () => {
        const result = resolveSpawnAgent('gpt5', allInstalled, {});

        expect(result).toEqual({
            type: 'error',
            errorMessage: "Unsupported agent type: 'gpt5'. Please update your CLI to the latest version.",
        });
    });

    it('falls back to claude for an unspecified agent when no policy is configured', () => {
        const result = resolveSpawnAgent(undefined, allInstalled, {});

        expect(result).toEqual({ type: 'ok', agent: 'claude' });
    });

    it('does not coerce when no agent policy is configured', () => {
        const result = resolveSpawnAgent('claude', codexOnly, {});

        expect(result).toEqual({ type: 'ok', agent: 'claude' });
    });

    it('does not probe for installed CLIs when no policy is configured', () => {
        let probes = 0;
        const probe = () => {
            probes += 1;
            return codexOnly();
        };

        resolveSpawnAgent('claude', probe, {});

        expect(probes).toBe(0);
    });
});
