/**
 * Which model a Codex session runs.
 *
 * This used to fall back to a hardcoded `gpt-5.5` whenever nothing else was
 * specified, which is a guess Happy is not in a position to make: a deployment
 * behind a gateway with an allowed-model list rejects the turn outright
 * (sokdak/happy-helm#17), and Codex already knows the answer from its own
 * `~/.codex/config.toml`.
 *
 * So there is no built-in model any more. Highest precedence first:
 *
 *   1. What the user picked, from the app's model picker or `--model`.
 *   2. `HAPPY_CODEX_MODEL`, for an operator pinning one daemon to one model.
 *   3. Nothing - the request omits the model and Codex uses its own default.
 *
 * `default` is the app's sentinel for "no explicit pick" and is treated as
 * unset at every level, including the override.
 */
const NO_EXPLICIT_MODEL = 'default';

function normalize(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === NO_EXPLICIT_MODEL) {
        return undefined;
    }
    return trimmed;
}

export function resolveCodexModel(
    requested: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    return normalize(requested) ?? normalize(env.HAPPY_CODEX_MODEL);
}
