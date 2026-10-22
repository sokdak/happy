import type { CLIAvailability } from './detectCLI';
import { agentSupportsEffortLevel } from './effortLevels';

const AGENT_KEYS = ['claude', 'codex', 'gemini', 'openclaw', 'agy'] as const;

export type AgentKey = typeof AGENT_KEYS[number];

interface UnknownAgentEntry {
    variable: string;
    name: string;
}

interface ParsedAgentList {
    agents: AgentKey[];
    unknown: UnknownAgentEntry[];
}

function parseAgentList(variable: string, value: string | undefined): ParsedAgentList {
    const agents: AgentKey[] = [];
    const unknown: UnknownAgentEntry[] = [];

    for (const entry of (value ?? '').split(/[,\s]+/)) {
        const name = entry.trim().toLowerCase();
        if (!name) {
            continue;
        }
        if ((AGENT_KEYS as readonly string[]).includes(name)) {
            agents.push(name as AgentKey);
        } else {
            unknown.push({ variable, name });
        }
    }

    return { agents, unknown };
}

interface AgentPolicy {
    configured: boolean;
    enabled: AgentKey[];
    disabled: AgentKey[];
    unknown: UnknownAgentEntry[];
}

function readAgentPolicy(env: NodeJS.ProcessEnv): AgentPolicy {
    const enabled = parseAgentList('HAPPY_ENABLED_AGENTS', env.HAPPY_ENABLED_AGENTS);
    const disabled = parseAgentList('HAPPY_DISABLED_AGENTS', env.HAPPY_DISABLED_AGENTS);
    const unknown = [...enabled.unknown, ...disabled.unknown];

    return {
        // An operator who misspelled an agent name still configured a policy.
        // Deriving "configured" from the parsed names alone is what let
        // HAPPY_ENABLED_AGENTS=codxe fall back to the unrestricted default --
        // the one outcome the operator was trying to prevent.
        configured: enabled.agents.length > 0 || disabled.agents.length > 0 || unknown.length > 0,
        enabled: enabled.agents,
        disabled: disabled.agents,
        unknown,
    };
}

function unknownAgentPolicyError(unknown: UnknownAgentEntry[]): string {
    const details = unknown.map(({ variable, name }) => `${variable}: '${name}'`).join(', ');
    return `Unknown agent name in the agent policy (${details}). Valid names are ${AGENT_KEYS.join(', ')}. `
        + 'Fix or unset the variable - an unreadable policy is refused rather than ignored, because ignoring it '
        + 'would re-enable every agent on PATH.';
}

function isAllowed(policy: AgentPolicy, key: AgentKey): boolean {
    // The allowlist is the stronger statement of intent: naming an agent there
    // settles the question even when the denylist names it too. This is the
    // precedence the documentation has always described.
    if (policy.enabled.length > 0) {
        return policy.enabled.includes(key);
    }
    return !policy.disabled.includes(key);
}

export function applyAgentPolicy(
    availability: CLIAvailability,
    env: NodeJS.ProcessEnv = process.env,
): CLIAvailability {
    const policy = readAgentPolicy(env);
    if (!policy.configured) {
        return availability;
    }

    const result = { ...availability };
    for (const key of AGENT_KEYS) {
        // A policy we cannot fully parse advertises nothing. Reporting the raw
        // PATH result instead would put agents back in the app's picker that
        // the operator asked us to hide.
        if (policy.unknown.length > 0 || !isAllowed(policy, key)) {
            result[key] = false;
        }
    }
    return result;
}

export type SpawnAgentResolution =
    | { type: 'ok'; agent: AgentKey; coercedFrom?: string }
    | { type: 'error'; errorMessage: string };

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

    const policy = readAgentPolicy(env);

    if (policy.unknown.length > 0) {
        return { type: 'error', errorMessage: unknownAgentPolicyError(policy.unknown) };
    }

    // Without an explicit policy the daemon keeps its historical behaviour:
    // an unspecified agent means Claude, and an agent that is missing from PATH
    // is still launched so the failure surfaces where it always has. Coercing
    // here would silently redirect agents on every default deployment.
    if (!policy.configured) {
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

/**
 * The parts of a spawn request that only mean something to the agent the
 * client asked for.
 *
 * `token` is a credential minted for the source agent -- staging it as the
 * target agent's credential rewrites a Claude OAuth token into
 * `CODEX_HOME/auth.json`. The model and permission vocabularies do not overlap
 * either (`claude-opus-5`, `bypassPermissions`), and a resume id names a
 * conversation only the source agent can read.
 *
 * `effortLevel` survives coercion only when the target agent has the level the
 * client asked for. The scales overlap in the middle but not at the ends -
 * `max` is Claude's alone and `none`/`minimal` are Codex's - so keeping it
 * unconditionally forwards a level the target rejects. Where they agree it is
 * the user's stated intent and worth carrying over.
 */
export interface SourceAgentRequestFields {
    token?: string;
    modelMode?: string;
    permissionMode?: string;
    effortLevel?: string;
    resumeClaudeSessionId?: string;
    resumeCodexThreadId?: string;
}

export function stripSourceAgentRequest<T extends SourceAgentRequestFields>(
    request: T,
    targetAgent: string,
): T {
    const effortLevel = request.effortLevel !== undefined
        && agentSupportsEffortLevel(targetAgent, request.effortLevel)
        ? request.effortLevel
        : undefined;

    return {
        ...request,
        token: undefined,
        modelMode: undefined,
        permissionMode: undefined,
        effortLevel,
        resumeClaudeSessionId: undefined,
        resumeCodexThreadId: undefined,
    };
}
