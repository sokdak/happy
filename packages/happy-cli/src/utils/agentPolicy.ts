import type { CLIAvailability } from './detectCLI';

const AGENT_KEYS = ['claude', 'codex', 'gemini', 'openclaw', 'agy'] as const;

export type AgentKey = typeof AGENT_KEYS[number];

function parseAgentList(value: string | undefined): AgentKey[] {
    if (!value) {
        return [];
    }
    return value
        .split(/[,\s]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry): entry is AgentKey => (AGENT_KEYS as readonly string[]).includes(entry));
}

export function applyAgentPolicy(
    availability: CLIAvailability,
    env: NodeJS.ProcessEnv = process.env,
): CLIAvailability {
    const enabled = parseAgentList(env.HAPPY_ENABLED_AGENTS);
    const disabled = parseAgentList(env.HAPPY_DISABLED_AGENTS);
    if (enabled.length === 0 && disabled.length === 0) {
        return availability;
    }

    const result = { ...availability };
    for (const key of AGENT_KEYS) {
        // An allowlist restricts to its members; it never marks a missing CLI
        // as present, so the PATH result still has the final say on `true`.
        if (enabled.length > 0 && !enabled.includes(key)) {
            result[key] = false;
            continue;
        }
        if (disabled.includes(key)) {
            result[key] = false;
        }
    }
    return result;
}

export type SpawnAgentResolution =
    | { type: 'ok'; agent: AgentKey; coercedFrom?: string }
    | { type: 'error'; errorMessage: string };

function isAgentPolicyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseAgentList(env.HAPPY_ENABLED_AGENTS).length > 0
        || parseAgentList(env.HAPPY_DISABLED_AGENTS).length > 0;
}

function isAgentKey(value: string): value is AgentKey {
    return (AGENT_KEYS as readonly string[]).includes(value);
}

export function resolveSpawnAgent(
    requested: string | undefined,
    // Lazy: probing PATH costs several subprocesses, and a deployment without a
    // policy never needs the answer. Spawning is a hot enough path to care.
    getAvailability: () => CLIAvailability,
    env: NodeJS.ProcessEnv = process.env,
): SpawnAgentResolution {
    if (requested !== undefined && !isAgentKey(requested)) {
        return {
            type: 'error',
            errorMessage: `Unsupported agent type: '${requested}'. Please update your CLI to the latest version.`,
        };
    }

    // Without an explicit policy the daemon keeps its historical behaviour:
    // an unspecified agent means Claude, and an agent that is missing from PATH
    // is still launched so the failure surfaces where it always has. Coercing
    // here would silently redirect agents on every default deployment.
    if (!isAgentPolicyConfigured(env)) {
        return { type: 'ok', agent: requested ?? 'claude' };
    }

    const availability = getAvailability();
    const candidates = AGENT_KEYS.filter((key) => availability[key]);
    if (candidates.length === 0) {
        return {
            type: 'error',
            errorMessage: 'No agent CLI is enabled on this machine. Check HAPPY_ENABLED_AGENTS / HAPPY_DISABLED_AGENTS and confirm the agent CLI is installed.',
        };
    }

    if (requested === undefined) {
        return { type: 'ok', agent: candidates[0] };
    }

    if (!availability[requested]) {
        return { type: 'ok', agent: candidates[0], coercedFrom: requested };
    }

    return { type: 'ok', agent: requested };
}
