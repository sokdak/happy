import { describe, expect, it } from 'vitest';
import { applyAgentPolicy, resolveSpawnAgent, stripSourceAgentRequest } from './agentPolicy';
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

describe('agent policy misconfiguration', () => {
    it('keeps the allowlist authoritative when both lists name the same agent', () => {
        const result = applyAgentPolicy(allInstalled(), {
            HAPPY_ENABLED_AGENTS: 'codex',
            HAPPY_DISABLED_AGENTS: 'codex',
        });

        expect(result.codex).toBe(true);
        expect(result.claude).toBe(false);
    });

    it('offers nothing when the allowlist contains only unknown names', () => {
        const result = applyAgentPolicy(allInstalled(), { HAPPY_ENABLED_AGENTS: 'codxe' });

        expect(result.claude).toBe(false);
        expect(result.codex).toBe(false);
        expect(result.gemini).toBe(false);
        expect(result.openclaw).toBe(false);
        expect(result.agy).toBe(false);
    });

    it('refuses to spawn when the allowlist contains only unknown names', () => {
        const result = resolveSpawnAgent(undefined, allInstalled, { HAPPY_ENABLED_AGENTS: 'codxe' });

        expect(result.type).toBe('error');
        expect(result.type === 'error' && result.errorMessage).toContain('codxe');
    });

    it('refuses to spawn when a list mixes a known name with an unknown one', () => {
        const result = resolveSpawnAgent(undefined, allInstalled, { HAPPY_ENABLED_AGENTS: 'codex, clade' });

        expect(result.type).toBe('error');
        expect(result.type === 'error' && result.errorMessage).toContain('clade');
    });

    it('refuses to spawn when the denylist contains an unknown name', () => {
        const result = resolveSpawnAgent(undefined, allInstalled, { HAPPY_DISABLED_AGENTS: 'claud' });

        expect(result.type).toBe('error');
        expect(result.type === 'error' && result.errorMessage).toContain('claud');
    });

    it('treats a whitespace-only policy value as unset', () => {
        const result = resolveSpawnAgent(undefined, allInstalled, { HAPPY_ENABLED_AGENTS: '  ' });

        expect(result).toEqual({ type: 'ok', agent: 'claude' });
    });

    it('resolves the allowlisted agent when both lists name it', () => {
        const result = resolveSpawnAgent(undefined, codexOnly, {
            HAPPY_ENABLED_AGENTS: 'codex',
            HAPPY_DISABLED_AGENTS: 'codex',
        });

        expect(result).toEqual({ type: 'ok', agent: 'codex' });
    });
});

describe('stripSourceAgentRequest', () => {
    it('drops credentials and launch fields that belong to the requested agent', () => {
        const request = {
            directory: '/work',
            token: 'claude-oauth-token',
            modelMode: 'claude-opus-5',
            permissionMode: 'bypassPermissions',
            resumeClaudeSessionId: 'claude-session',
            resumeCodexThreadId: 'codex-thread',
        };

        const result = stripSourceAgentRequest(request, 'codex');

        expect(result.token).toBeUndefined();
        expect(result.modelMode).toBeUndefined();
        expect(result.permissionMode).toBeUndefined();
        expect(result.resumeClaudeSessionId).toBeUndefined();
        expect(result.resumeCodexThreadId).toBeUndefined();
    });

    it('keeps fields that mean the same thing to every agent', () => {
        const request = {
            directory: '/work',
            effortLevel: 'medium',
            environmentVariables: { FOO: 'bar' },
            parentSessionId: 'parent',
            modelMode: 'claude-opus-5',
        };

        const result = stripSourceAgentRequest(request, 'codex');

        expect(result.directory).toBe('/work');
        expect(result.effortLevel).toBe('medium');
        expect(result.environmentVariables).toEqual({ FOO: 'bar' });
        expect(result.parentSessionId).toBe('parent');
    });

    it('does not mutate the request it was given', () => {
        const original = { directory: '/work', token: 'secret', modelMode: 'claude-opus-5' };

        stripSourceAgentRequest(original, 'codex');

        expect(original.token).toBe('secret');
        expect(original.modelMode).toBe('claude-opus-5');
    });

    it('keeps an effort level the target agent understands', () => {
        const request = { token: 'secret', effortLevel: 'medium' };

        expect(stripSourceAgentRequest(request, 'codex').effortLevel).toBe('medium');
    });

    it('drops an effort level the target agent does not have', () => {
        // A Claude draft can ask for `max`, which Codex has no equivalent for.
        // Forwarding it launches Codex with a level its own validation rejects.
        const request = { token: 'secret', effortLevel: 'max' };

        expect(stripSourceAgentRequest(request, 'codex').effortLevel).toBeUndefined();
    });

    it('drops a Codex-only effort level when coercing towards Claude', () => {
        const request = { token: 'secret', effortLevel: 'minimal' };

        expect(stripSourceAgentRequest(request, 'claude').effortLevel).toBeUndefined();
    });

    it('drops the effort level for an agent that takes none', () => {
        const request = { token: 'secret', effortLevel: 'medium' };

        expect(stripSourceAgentRequest(request, 'gemini').effortLevel).toBeUndefined();
    });
});
